'use strict'

const assert = require('assert')
const mapSeries = require('p-each-series')
const rmrf = require('rimraf')
const IPFS = require('ipfs')
const OrbitDB = require('../src/OrbitDB')
const config = require('./config')
const hasIpfsApiWithPubsub = require('./test-utils').hasIpfsApiWithPubsub

const dbPath1 = './orbitdb/tests/replication/daemon1'
const dbPath2 = './orbitdb/tests/replication/daemon2'
const ipfsPath1 = './orbitdb/tests/replication/daemon1/ipfs'
const ipfsPath2 = './orbitdb/tests/replication/daemon2/ipfs'

const waitForPeers = (ipfs, channel) => {
  return new Promise((resolve, reject) => {
    console.log("Waiting for peers...")
    const interval = setInterval(() => {
      ipfs.pubsub.peers(channel)
        .then((peers) => {
          if (peers.length > 0) {
            console.log("Found peers, running tests...")
            clearInterval(interval)
            resolve()
          }
        })
        .catch((e) => {
          clearInterval(interval)
          reject(e)
        })
    }, 1000)
  })
}

describe('orbit-db - Replication', function() {
  this.timeout(config.timeout)

  let ipfs1, ipfs2, client1, client2, db1, db2

  before(function (done) {
    config.daemon1.repo = ipfsPath1
    config.daemon2.repo = ipfsPath2
    rmrf.sync(dbPath1)
    rmrf.sync(dbPath2)
    ipfs1 = new IPFS(config.daemon1)
    ipfs1.on('error', done)
    ipfs1.on('ready', () => {
      assert.equal(hasIpfsApiWithPubsub(ipfs1), true)
      ipfs2 = new IPFS(config.daemon2)
      ipfs2.on('error', done)
      ipfs2.on('ready', () => {
        assert.equal(hasIpfsApiWithPubsub(ipfs2), true)
        client1 = new OrbitDB(ipfs1)
        client2 = new OrbitDB(ipfs2)
        done()
      })
    })
  })

  after(() => {
    if (client1)
      client1.disconnect()
    
    if (client2)
      client2.disconnect()
    
    if (ipfs1) 
      ipfs1.stop()

    if (ipfs2) 
      ipfs2.stop()
  })

  describe('two peers', function() {
    beforeEach(() => {
      db1 = client1.eventlog(config.dbname, { 
        path: dbPath1
      })

      db2 = client2.eventlog(db1.path, { 
        path: dbPath2
      })

      // FIX: temp way to give access to others to a db
      db1._access.write.push(db2._key.getPublic('hex'))
      db2._access.write.push(db1._key.getPublic('hex'))
    })

    it('replicates database of 1 entry', (done) => {
      waitForPeers(ipfs1, db1.path)
        .then(() => {
          db2.events.once('error', done)
          db2.events.once('synced', () => {
            const items = db2.iterator().collect()
            assert.equal(items.length, 1)
            assert.equal(items[0].payload.value, 'hello')
            done()
          })
          db1.add('hello')
          .catch(done)
        })
        .catch(done)
    })

    it('replicates database of 100 entries', (done) => {
      const entryCount = 100
      const entryArr = []
      let timer

      for (let i = 0; i < entryCount; i ++)
        entryArr.push(i)

      waitForPeers(ipfs1, db1.path)
        .then(() => {
          let count = 0
          db2.events.once('error', done)
          db2.events.on('synced', () => {
            if (count === entryCount && !timer) {
              timer = setInterval(() => {
                const items = db2.iterator({ limit: -1 }).collect()
                if (items.length === count) {
                  clearInterval(timer)
                  assert.equal(items.length, entryCount)
                  assert.equal(items[0].payload.value, 'hello0')
                  assert.equal(items[items.length - 1].payload.value, 'hello99')
                  setTimeout(done, 5000)
                }
              }, 1000)
            }
          })

          db1.events.on('write', () => count++)

          mapSeries(entryArr, (i) => db1.add('hello' + i))
            .catch(done)
        })
        .catch(done)
    })
  })
})
