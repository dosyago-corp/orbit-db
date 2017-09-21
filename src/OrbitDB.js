'use strict'

const path = require('path')
const EventStore = require('orbit-db-eventstore')
const FeedStore = require('orbit-db-feedstore')
const KeyValueStore = require('orbit-db-kvstore')
const CounterStore = require('orbit-db-counterstore')
const DocumentStore = require('orbit-db-docstore')
const Pubsub = require('orbit-db-pubsub')
const Cache = require('orbit-db-cache')
const Keystore = require('orbit-db-keystore')
const parseAddress = require('./parse-address')
const AccessController = require('./ipfs-access-controller')

class OrbitDB {
  constructor(ipfs, directory = './orbitdb', options = {}) {
    this._ipfs = ipfs
    this.id = options.peerId || (this._ipfs._peerInfo ? this._ipfs._peerInfo.id._idB58String : 'default')
    this._pubsub = options && options.broker 
      ? new options.broker(ipfs) 
      : new Pubsub(ipfs, this.id)
    this.stores = {}
    this.types = ['eventlog', 'feed', 'docstore', 'counter', 'keyvalue']
    this.keystore = new Keystore(path.join(directory, this.id, '/keystore'))
    this.key = this.keystore.getKey(this.id) || this.keystore.createKey(this.id)
  }

  /* Databases */
  feed(dbname, options) {
    return this._createStore(FeedStore, dbname, options)
  }

  eventlog(dbname, options) {
    return this._createStore(EventStore, dbname, options)
  }

  kvstore(dbname, options) {
    return this._createStore(KeyValueStore, dbname, options)
  }

  async counter(address, options) {
    return this.open(address, options.path, Object.assign({ sync: false }, options), 'counter')
  }

  async docstore(address, options) {
    return this.open(address, options.path, Object.assign({ sync: false }, options), 'docstore')
  }

  disconnect() {
    Object.keys(this.stores).forEach((e) => this.stores[e].close())
    if (this._pubsub) this._pubsub.disconnect()
    this.stores = {}
  }

  async create (address, type, directory, options) {
    const p = path.join(directory || './orbitdb')
    // const keystore = new Keystore(path.join(p, this.id, '/keystore'))
    const key = this.keystore.getKey(this.id) || this.keystore.createKey(this.id)

    // Create Access Controller
    const accessController = new AccessController(this._ipfs)
    // Add the creator as the admin of the database
    accessController.add('admin', key.getPublic('hex'))
    if (options && options.write) {
      // Add write access keys
      options.write.forEach(e => accessController.add('write', e))
    }
    // Persist in IPFS
    const accessControllerAddress = await accessController.save()

    // Create database manifest file
    const createDBManifest = () => {
      return {
        name: address.toString(),
        type: type,
        accessController: path.join('/ipfs', accessControllerAddress),
      }
    }

    const manifest = createDBManifest()
    // console.log(manifest)

    let addr
    let manifestHash
    return this._ipfs.object.put(new Buffer(JSON.stringify(manifest)))
      .then((dag) => dag.toJSON().multihash.toString())
      // .then((hash) => console.log(hash))
      .then((hash) => {
        manifestHash = hash
        addr = OrbitDB.parseAddress(address, manifestHash)
        // console.log("addr1", addr)
        this._cache = new Cache(p, addr.indexOf('/orbitdb') === 0 ? addr.replace('/orbitdb', '') : addr)
        options = Object.assign({}, options, { path: p, cache: this._cache, accessController: manifest.accessController })
        return this._cache.load()
      })
      .then(() => this._cache.get(addr + ".manifest"))
      .then((hash) => {
        if (hash) {
          throw new Error(`Database '${addr}' already exists!`)
        }

        if (!OrbitDB.isValidType(this.types, type)) {
          throw new Error(`Invalid database type '${type}'.`)
        }

        if (!hash)
          return this._cache.set(addr + '.manifest', manifestHash)
      })
      .then(() => this._cache.set(addr + '.type', type))
      // TODO: check if needed
      .then(() => this._cache.set(addr + '.localhead', null))
      // TODO: check if needed
      .then(() => this._cache.set(addr + '.remotehead', null))
      .then(() => this._openDatabase(addr, type, options))
  }

  async open (address, directory, options, createAsType) {
    const dbpath = path.join(directory || './orbitdb')
    const addr = OrbitDB.parseAddress(address, this.id)
    const addressWithoutProtocol = addr.indexOf('/orbitdb') === 0 ? addr.replace('/orbitdb', '') : addr
    this._cache = new Cache(dbpath, addressWithoutProtocol)
    options = Object.assign({ sync: true }, options, { path: dbpath, cache: this._cache })

    // console.log("addr2", addr)

    // Get the manifest hash from the address:
    // /orbitdb/QmYrkqiKHezNQyiNdnjue4RapKnipKY9CYZb1a3bRSxmxE/1506687819429
    //          ^-------------- manifest hash ---------------^
    const manifestHash = addressWithoutProtocol.split('/').filter(e => e && e !== '')[0]

    await this._cache.load()
    const localManifest = await this._cache.get(addr + '.manifest')

    // console.log("1", addr, address, localManifest, createAsType)
    if (!localManifest && !options.sync) {
      if (createAsType) {
        return this.create(address, createAsType, directory, options)
      }
      return Promise.resolve(null)
    }

    let manifest = {}
    return this._ipfs.object.get(manifestHash)
      .then((obj) => JSON.parse(obj.toJSON().data))
      .then(async (data) => {
        manifest = data
        // console.log("manifest:", manifest)
        options.accessController = manifest.accessController
      })
      .then(() => this._cache.set(addr + '.manifest', manifestHash))
      .then(() => this._cache.get(addr + '.type'))
      .then((type) => {
        return this._openDatabase(addr, manifest.type, options)
      })
  }

  _openDatabase (dbname, type, options) {
    if (type === 'counter')
      return this._createStore(CounterStore, dbname, options)
    else if (type === 'eventlog')
      return this.eventlog(dbname, options)
    else if (type === 'feed')
      return this.feed(dbname, options)
    else if (type === 'docstore')
      return this._createStore(DocumentStore, dbname, options)
    else if (type === 'keyvalue')
      return this.kvstore(dbname, options)
    else
      throw new Error(`Unknown database type '${type}'`)
  }

  /* Private methods */
  async _createStore(Store, dbname, options) {
    const addr = OrbitDB.parseAddress(dbname, this.id)

    let accessController
    if (options.accessController) {
      accessController = new AccessController(this._ipfs)
      await accessController.load(options.accessController) 
    }

    const opts = Object.assign({ replicate: true }, options, { accessController: accessController, keystore: this.keystore })
    const store = new Store(this._ipfs, this.id, dbname, opts)
    store.events.on('write', this._onWrite.bind(this))
    store.events.on('ready', this._onReady.bind(this))
    store.events.on('close', this._onClose.bind(this))

    this.stores[addr] = store

    if(opts.replicate && this._pubsub)
      this._pubsub.subscribe(addr, this._onMessage.bind(this))

    return store
  }

  // Callback for receiving a message from the network
  _onMessage(dbname, heads) {
    const store = this.stores[dbname]
    store.sync(heads)
  }

  // Callback for local writes to the database. We the update to pubsub.
  _onWrite(dbname, hash, entry, heads) {
    if(!heads) throw new Error("'heads' not defined")
    if(this._pubsub) setImmediate(() => this._pubsub.publish(dbname, heads))
  }

  // Callback for database being ready
  _onReady(dbname, heads) {
    if(heads && this._pubsub) {
      setTimeout(() => this._pubsub.publish(dbname, heads), 1000)
    }
  }

  _onClose(dbname) {
    if(this._pubsub) this._pubsub.unsubscribe(dbname)
    if (this.stores[dbname]) {
      this.stores[dbname].events.removeAllListeners('write')
      this.stores[dbname].events.removeAllListeners('ready')
      this.stores[dbname].events.removeAllListeners('close')
      this.stores[dbname].close()
      delete this.stores[dbname]
    }
  }

  static isValidType (types, type) {
    return types.includes(type)
  }

  static parseAddress (address, id) {
    return parseAddress(address, id)
  }
}

module.exports = OrbitDB
