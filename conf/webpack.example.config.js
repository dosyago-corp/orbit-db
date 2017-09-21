'use strict'

const path = require('path')
const webpack = require('webpack')
const Uglify = require('uglifyjs-webpack-plugin')

const uglifyOptions = {
  uglifyOptions: {
    mangle: false,
  },
}

module.exports = {
  entry: './examples/browser/index.js',
  output: {
    filename: './examples/browser/bundle.js'
  },
  target: 'web',
  devtool: 'none',
  node: {
    console: false,
    process: 'mock',
    Buffer: true
  },
  externals: {
    fs: '{}',
  },
  plugins: [
    new webpack.DefinePlugin({
      'process.env': {
        'NODE_ENV': JSON.stringify(process.env.NODE_ENV)
      }
    }),
    new Uglify(uglifyOptions),
  ],
  resolve: {
    modules: [
      'node_modules',
      path.resolve(__dirname, '../node_modules')
    ],
    alias: {
      // These are needed because node-libs-browser depends on outdated
      // versions
      //
      // Can be dropped once https://github.com/devongovett/browserify-zlib/pull/18
      // is shipped
      zlib: 'browserify-zlib-next',
      // Can be dropped once https://github.com/webpack/node-libs-browser/pull/41
      // is shipped
      http: 'stream-http'
    }
  },
  resolveLoader: {
    modules: [
      'node_modules',
      path.resolve(__dirname, '../node_modules')
    ],
    moduleExtensions: ['-loader']
  },
  module: {
    rules: [{
      test: /\.json$/,
      loader: 'json-loader'
    }]
  },
}
