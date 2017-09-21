'use strict'

const path = require('path')
const assert = require('assert')
const rmrf = require('rimraf')
const mapSeries = require('p-each-series')
const OrbitDB = require('../src/OrbitDB')
const config = require('./config')
const startIpfs = require('./start-ipfs')
const waitForPeers = require('./wait-for-peers')

const dbPath1 = './orbitdb/tests/counters/daemon1'
const dbPath2 = './orbitdb/tests/counters/daemon2'
const ipfsPath1 = './orbitdb/tests/counters/daemon1/ipfs'
const ipfsPath2 = './orbitdb/tests/counters/daemon2/ipfs'

describe('CounterStore', function() {
  this.timeout(config.timeout)

  let orbitdb1, orbitdb2
  let ipfs1, ipfs2

  before(async () => {
    rmrf.sync(dbPath1)
    rmrf.sync(dbPath2)
    config.daemon1.repo = ipfsPath1
    config.daemon2.repo = ipfsPath2
    ipfs1 = await startIpfs(config.daemon1)
    ipfs2 = await startIpfs(config.daemon2)
  })

  after(() => {
    if (orbitdb1)
      orbitdb1.disconnect()

    if (orbitdb2)
      orbitdb2.disconnect()

    if (ipfs1)
      ipfs1.stop()

    if (ipfs2)
      ipfs2.stop()
  })

  beforeEach(() => {
    orbitdb1 = new OrbitDB(ipfs1, './orbitdb/1')
    orbitdb2 = new OrbitDB(ipfs2, './orbitdb/2')
  })

  describe('counters', function() {
    let address

    it('increases a counter value', async () => {
      const counter = await orbitdb1.counter('counter test', { path: dbPath1 })
      address = counter.path
      await mapSeries([13, 1], (f) => counter.inc(f))
      assert.equal(counter.value, 14)
    })

    it('opens a saved counter', async () => {
      const counter = await orbitdb1.open(address, dbPath1)
      await counter.load()
      assert.equal(counter.value, 14)
    })

    it('syncs counters', async (done) => {
      const options = {
        // Set write access for both clients
        write: [
          orbitdb1.key.getPublic('hex'), 
          orbitdb2.key.getPublic('hex')
        ],
      }

      const numbers = [[13, 10], [2, 5]]
      const increaseCounter = (counterDB, i) => mapSeries(numbers[i], n => counterDB.inc(n))

      // Create a new counter database in the first client
      const counter1 = await orbitdb1.create(new Date().getTime().toString(), 'counter', dbPath1, options)
      // Open the database in the second client
      const counter2 = await orbitdb2.open(counter1.address, dbPath2)

      try {
        // Wait for peers to connect first
        await waitForPeers(ipfs1, [orbitdb2.id], counter1.address)
        await waitForPeers(ipfs2, [orbitdb1.id], counter1.address)
        // Increase the counters sequentially
        await mapSeries([counter1, counter2], increaseCounter)
        // Wait for a while to make sure db's have been synced
        setTimeout(() => {
          assert.equal(counter1.value, 30)
          assert.equal(counter2.value, 30)
          done()
        }, 2000)
      } catch (e) {
        done(e)
      }
    })
  })
})
