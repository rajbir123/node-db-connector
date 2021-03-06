'use strict'

var VError = require('verror')

class DbConnector {
  constructor(){
    this._options = null
    this._mongooseDbName = null
    this._mongoDbNames = null
    this._mongoAliases = null // list of aliases (for wich there is a top-level property of the same name that references DB object)
    this._pgDbNames = null
    this._mysqlDbNames = null
    this._redisDbNames = null
    this._pgPromise = null // pg-promise library instance
    this._logger = null
  }

  init(configs, options){
    this._options = options || {}
    this._connPromises = []
    this._mongoDbNames = []
    this._mongoAliases = []
    this._pgDbNames = []
    this._mysqlDbNames = []
    this._redisDbNames = []
    this._logger = this._options.logger || console

    this._options.separator = this._options.separator || ':'

    // find mongoose connection
    var mongooseIdx = configs.findIndex((x) => {return x.mongoose === true})
    if (mongooseIdx >= 0){
      let mongooseConfig = configs.splice(mongooseIdx, 1)[0] // get mongoose config and remove it from array
      this._connectMongoose(mongooseConfig)
    }

    // find & connect to mongo DBs
    var mongoConfigs = configs.filter((x) => {return x.connectionString.startsWith('mongodb://')})
    if (mongoConfigs.length > 0){
      let mongoclient = require('mongodb').MongoClient
      for (let cfg of mongoConfigs){
        this._connectMongo(cfg, mongoclient)
      }
    }

    // find mysql configs
    var mysqlConfigs = configs.filter((x) => {return x.connectionString.startsWith('mysql://')})
    if (mysqlConfigs.length > 0){
      let mysql = require('promise-mysql')
      for (let cfg of mysqlConfigs){
        this._connectMysql(cfg, mysql)
      }
    }

    // find postgresql configs
    var pgConfigs = configs.filter((x) => {return x.connectionString.startsWith('postgresql://')})
    if (pgConfigs.length > 0){
      this._pgPromise = require('pg-promise')()
      for (let cfg of pgConfigs){
        this._connectPostgresql(cfg)
      }
    }

    // find redis configs
    var redisConfigs = configs.filter((x) => {return x.connectionString.startsWith('redis://')})
    if (redisConfigs.length > 0){
      let redis = require('promise-redis')()
      for (let cfg of redisConfigs){
        this._connectRedis(cfg, redis)
      }
    }

    return Promise.all(this._connPromises)
  }

  // close all connections
  close(){
    this._closePromises = [
      this._closeMongoose(),
      this._closePostgresql()
    ]
    this._closeMongos()
    this._closeMysql()
    this._closeRedis()
    return Promise.all(this._closePromises)
  }

  // connect using Mongoose
  _connectMongoose(config){
    if (this._options.mongoose == null)
      throw new VError('Mongoose object must be provided')

    this._options.mongoose.Promise = global.Promise // tells mongoose to use native Promise
    this._options.mongoose.connect(config.connectionString, { useMongoClient: true })
    var mongoosedb = this._options.mongoose.connection
    this._mongooseDbName = config.name
    this._connPromises.push(new Promise((resolve, reject) => {

      // custom timeout when mongoose doesn't raise an error at all
      let tm = setTimeout(() => {
        reject(new VError(`Mongoose/${this._mongooseDbName} connection error`))
      }, 60 * 1000) // 1 minute

      mongoosedb.on('error', (err) => {
        clearTimeout(tm)
        reject(new VError(err, `Mongoose/${self._mongooseDbName} connection error`))
      })

      mongoosedb.once('open', () => {
        clearTimeout(tm)
        self._logger.info(`Mongoose/${self._mongooseDbName} connection OK`)
        resolve()
      })
    }))
  }

  // connecto to Mongo using native driver
  _connectMongo(config, mongoclient){
    this._connPromises.push(new Promise((resolve, reject) => {
      mongoclient.connect(config.connectionString, (err, db)=>{
        let logName = (config.name || db.databaseName).toString() // name to show in logs
        if (err != null)
          return reject(new VError(err, `Mongo/${logName} connection error`))

        // names of database to reference
        let dbNames
        if (!config.name)
          dbNames = [db.databaseName]
        else if (typeof config.name === 'string')
          dbNames = [config.name]
        else if (Array.isArray(config.name))
          dbNames = config.name
        else
          return reject(new VError('Name must be a string or an aray of string'))

        // computes a reference name for the main connection to the db
        var refName = db.databaseName + ':' + dbNames.map(x => {
          let s = x.split(':')
          return s[1] || s[0]
        }).join(', ')

        if (this[refName])
          return reject(new VError('Cannot reference multiple DBs with name %s', refName))

        // reference connected db name by adding it as class property
        this._mongoDbNames.push(refName)
        this[refName] = db

        // reference all dbs. But their names are not added to list of dbs;
        // since they use the same socket connection as the main db, there's no need to close them individually
        for (let name of dbNames){
          let alias
          [name, alias] = name.split(this._options.separator)
          alias = alias || name

          if (this[alias])
            throw new VError('Cannot have multiple connections to alias %s', alias)

          this[alias] = db.db(name)
          this._mongoAliases.push(alias)
        }

        this._logger.info(`Mongo/${logName} connection ok`)
        resolve()
      })
    }))
  }

  // opens a postgreql connection
  _connectPostgresql(config){
    // Db[cfg.name] = pgp(cfg.connectionString)
    this._connPromises.push(new Promise((resolve, reject) => {
      let db = this._pgPromise(config.connectionString)
      db.connect().then((obj) => {
        this[config.name] = db
        this._pgDbNames.push(config.name)
        this._logger.info(`PostgreSql/${config.name} connection OK`)
        obj.done()
        resolve()
      })
      .catch((err) => {
        reject(new VError(err, `PostgreSql/${config.name} connection error`))
      })
    }))
  }

  _connectMysql(config, mysql){
    var mySqlPool = mysql.createPool(config.connectionString)
    if (!mySqlPool)
      return this._connPromises.push(Promise.reject(new VError(`Invalid MySql/${config.name} connection string`)))

    this._connPromises.push(new Promise((resolve, reject) => {
      mySqlPool.getConnection((err, cnx) => {
        if (err)
          return reject(new VError(err, `Mysql/${config.name} connection error`))

        this[config.name] = mySqlPool
        this._mysqlDbNames.push(config.name)
        this._logger.info(`Mysql/${config.name} connection OK`)
        resolve()
      })
    }))
  }

  // connect to Redis
  _connectRedis(config, redis){
    this._connPromises.push(new Promise((resolve, reject) => {
      var connected, client = redis.createClient(config.connectionString)
      // Open connection is not promisify, use event handlers instead
      client.on("ready", () => {
        // reference db instance by adding it as class property
        this[config.name] = client
        this._redisDbNames.push(config.name)
        this._logger.info(`Redis/${config.name} connection OK`)
        connected = true
        resolve()
      })
      // client will emit error when encountering an error connecting to the Redis server
      // OR when any other in node_redis occurs, that's why reject method is called only if client not connected yet
      client.on("error", (err) => {
        this._logger.error(new VError(err, `Redis/${config.name}: an error occured`))
        if (!connected)
          reject(new VError(err, `Redis/${config.name} connection error`))
      })
    }))
  }

  // close mongoose connection
  _closeMongoose(){
    if (this._mongooseDbName == null)
      return Promise.resolve()

    return new Promise((resolve, reject) =>{
      this._options.mongoose.disconnect((err) => {
        if (err != null)
          this._logger.info(`Mongoose/${this._mongooseDbName} connection close error`)
        else
          this._logger.info(`Mongoose/${this._mongooseDbName} connection closed`)
        resolve()
      })
    })
  }

  //  close all native mongos connections
  _closeMongos(){
    this._mongoAliases.forEach(alias => {
      delete this[alias]
    })

    this._mongoDbNames.forEach((refName)=>{
      if (this[refName] == null)
        return

      this._closePromises.push(this[refName].close().then(()=>{
        self._logger.info(`Mongo/${refName} connection closed`)
        delete this[refName]
      })
      .catch(()=>{
        self._logger.info.log(`Mongo/${refName} connection close error`)
        delete this[refName]
        return Promise.resolve() // resolve anyway
      }))
    })
  }

  // closes postgresql connections
  _closePostgresql(){
    if (this._pgDbNames.length > 0){
      this._pgPromise.end()
      for (let name of this._pgDbNames)
        this._logger.info(`Postgresql/${name} connection closed`)
    }
    return Promise.resolve()
  }

  // closes all mysql connections
  _closeMysql(){
    this._mysqlDbNames.forEach((dbName) => {
      this._closePromises.push(this[dbName].end().then(() => {
        self._logger.info(`Mysql/${dbName} connection closed`)
      })
      .catch(()=>{
        self._logger.info(`Mysql/${dbName} connection close error`)
        return Promise.resolve() // resolve anyway
      }))
    })
  }

  //  close all redis connections
  _closeRedis(){
    this._redisDbNames.forEach((dbName)=>{
      if (this[dbName] == null)
        return
      this._closePromises.push(new Promise((resolve, reject) => {
        // Close connection is not promisify, use event handlers instead
        this[dbName].on("end", () => {
          self._logger.info(`Redis/${dbName} connection closed`)
        })
        this[dbName].quit()
        resolve() // resolve anyway, but end event may not be logged
      }))
    })
  }
}

const self = module.exports = exports = new DbConnector()
