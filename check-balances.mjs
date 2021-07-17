/// <reference path="./rnode-grpc-gen/js/rnode-grpc-js.d.ts" />
import R from 'ramda'
import fs from 'fs'
import https from 'https'
import { exit } from 'process'
import grpc from '@grpc/grpc-js'
import fetch from 'node-fetch'
import { rnodeDeploy } from '@tgrospic/rnode-grpc-js'

// Generated files with rnode-grpc-js tool
// Import generated protobuf types (in global scope)
import * as ds from './rnode-grpc-gen/js/DeployServiceV1_pb.js'
import * as ps from './rnode-grpc-gen/js/ProposeServiceV1_pb.js'

const protoSchemaFile = fs.readFileSync('./rnode-grpc-gen/js/pbjs_generated.json', 'utf8')
const protoSchema     = JSON.parse(protoSchemaFile)

const host = 'observer-eu.services.mainnet.rchain.coop:40401'

const options = { grpcLib: grpc, host, protoSchema }

const { lastFinalizedBlock, exploratoryDeploy } = rnodeDeploy(options)

function getBalancesRho(addrList) {
  // const addrListJson = JSON.stringify(addrList, void 1, 2)
  const addrListJson = JSON.stringify(addrList)

  const myRho = `
    new
      return,
      insert(\`rho:registry:insertArbitrary\`),
      rl(\`rho:registry:lookup\`),
      listOpsCh, RevVaultCh
    in {
      rl!(\`rho:rchain:revVault\`, *RevVaultCh) |
      rl!(\`rho:lang:listOps\`, *listOpsCh) |
      for (@(_, RevVault) <- RevVaultCh;
          @(_, ListOps) <- listOpsCh){
        new initializeAddr, addressesCh, balancesCh, sum, coopTotalCh in{
          contract initializeAddr(addr, ret) = {
            new vaultCh, balanceCh in {
              @RevVault!("findOrCreate", *addr, *vaultCh) |
              for (@(true, vault) <- vaultCh){
                @vault!("balance", *balanceCh) |
                for (@balance <- balanceCh){ ret!((*addr, balance)) }
              }
            }
          } |
          addressesCh!(${addrListJson}) |
          new totalCh, uriCh in {
            for (@addresses <- addressesCh){
              @ListOps!("parMap", addresses, *initializeAddr, *return)
            }
          }
        }
      }
    }
   `
  return myRho
}

const getRhoResult = walletsMap => async function (rhoTerm) {
  const res = await exploratoryDeploy({term: rhoTerm})

  const tuplesPar = res.result.postblockdataList.flatMap(x => x.exprsList.flatMap(x => x.eListBody.psList.flatMap(x => x.exprsList.map(x => x.eTupleBody.psList))))

  return tuplesPar.map(x => {
    const addr = x[0].exprsList[0].gString
    const rev  = x[1].exprsList[0].gInt
    // Check balance
    const exportedRev = walletsMap.get(addr)
    const balanceOk = exportedRev === rev
    return [addr, rev, exportedRev, balanceOk]
  })
}

const C = { GREEN: "\x1b[0;32m", RED: "\x1b[0;31m", NC: "\x1b[0m" }

;(async () => {
  const snapshotUrl     = `https://raw.githubusercontent.com/rchain/rchain/dev/wallets_REV_BLOCK-908300.txt`
  const walletsFileName = `wallets.txt`

  if (!fs.existsSync(walletsFileName)) {
    console.log(`Wallets.txt does not exists. Downloading ${C.GREEN}${snapshotUrl}...${C.NC}`)
    // Download wallets file / Final Snapshot
    const body = await fetch(snapshotUrl).then(res => res.text())
    // Write to a file
    fs.writeFileSync(walletsFileName, body, 'utf8')
  }

  // Load wallets file exported from main net block 908300
  const walletsFile = fs.readFileSync(walletsFileName, 'utf8')

  const lineParser       = /^([1-9a-zA-Z]+),([0-9]+)/gm
  const tuplesImported   = walletsFile.matchAll(lineParser)
  const tuplesImportedAr = Array.from(tuplesImported)
  const wallets          = tuplesImportedAr.map(([_, addr, rev]) => [addr, parseInt(rev)])
  const walletsMap       = new Map(wallets)
  const addresses        = wallets.map(([addr]) => addr)

  // Check duplicate addresses
  if (wallets.length !== walletsMap.size) {
    console.log(`${C.GREEN}REV addresses contains duplicates!${C.NC}`)
  }

  console.log(`${C.GREEN}Validating ${addresses.length} REV balances.${C.NC}`)

  // Limit for results, pars and requests
  const maxToProcess     = 5_000 // Hard Fork has 11,822 accounts
  const balancePerDeploy = 25
  const parRequests      = 50

  // Create deploys and requests in chunks
  const promiseChunks = R.pipe(
    R.take(maxToProcess),
    R.splitEvery(balancePerDeploy),
    R.map(getBalancesRho),
    R.map(x => () => getRhoResult(walletsMap)(x)),
    R.splitEvery(parRequests),
  )(addresses)

  // Request results handler
  const resultChunksP = promiseChunks.map(requests => async () => {
    const resultChunks = await Promise.all(requests.map(f => f()))
    const results      = resultChunks.flat()

    results.forEach(([addr, rev, exportedRev, balanceOk]) => {
      if (balanceOk) {
        console.log(`OK:${C.GREEN} ${addr}: ${exportedRev} == ${rev}${C.NC}`)
      } else {
        console.log(`FAIL:${C.RED} ${addr}: ${exportedRev} != ${rev}${C.NC}`)
      }
    })

    return results
  })

  // Execute chunks in sequence with parallel requests
  const [resultChunks, totalCount] = await R.reduce(async (accP, p) => {
    const [acc, count] = await accP
    const results = await p()
    const current = count + results.length
    console.log(`Checked so far: ${C.GREEN}${current}${C.NC}`)
    return [[...acc, results], current]
  }, [[], 0])(resultChunksP)

  console.log(`Total balance checked: ${C.GREEN}${totalCount}${C.NC}`)

  // Calculate failed validations
  const failed = resultChunks.flatMap(results => results.filter(([,,, ok]) => !ok))

  if (failed.length === 0) {
    console.log(`${C.GREEN}REV balance validation completed succesfully!${C.NC}`)
  } else {
    console.log(`${C.RED}Check failed for ${failed.length} account(s).${C.NC}`)
    exit(-1)
  }
})()
