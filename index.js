const fs = require('fs');
const path = require('path');

const bodyParser = require('body-parser');
const express = require('express');
const webpack = require('webpack');
const yaml = require('js-yaml');
const enableDestroy = require('server-destroy');

const ProgressPlugin = require('webpack/lib/ProgressPlugin');

const statOptions = {
  colors: true
};

let app;
let server;

let PORT = 3000;

/* *** INTERNAL METHODS *** */
const getRoutesFromYml = (serverOutputPath) => {
  try {
    const serverFilePath = `${serverOutputPath}/handler.js`;
    const api = yaml.safeLoad(fs.readFileSync(path.resolve(__dirname, '../../serverless.yml'), 'utf8'));

    delete require.cache[require.resolve(serverFilePath)];
    const handler = require(serverFilePath);

    let routes = [];
    Object.keys(api.functions).forEach( funcName => {
      routes = routes.concat(
        api.functions[funcName].events.map( event => {
          const handlerName = api.functions[funcName].handler.split('.').pop();
          const replacer = (match) => { return `:${match.slice(1, -1)}` }

          return {
            method: event.http.method,
            path: event.http.path.replace((/{([a-z]+)}/gi), replacer),
            handler: handler[handlerName]
          };
        })
      );
    });

    return routes;
  } catch (e) {
    console.log(e);
  }
};

const wrapLambdaSignature = (func, req, res) => {
  const event = {
    path: req.path,
    method: req.method,
    headers: {
      'User-Agent': req.headers['user-agent'],
      'Cookie': req.headers.cookie
    },
    body: req.body,
    pathParameters: req.params,
    queryStringParameters: req.query
  };

  const context = {
    done(err, data) {
      if (data.headers) {
        res.set(data.headers);
      }

      res.status(data.statusCode || 200).send(data.body);
    }
  };

  func(event, context);
};

const startApp = () => {
  app = express();

  app.use(bodyParser.json());

  app.use(express.static('./dist-client/public'));

  server = app.listen(PORT);

  enableDestroy(server);

  console.log('new server created');
};

const restartApp = () => {
  console.log('restart app...')

  if (server) {
    server.destroy();
    console.log('server closed');
  }

  startApp();
};

/* *** *** */

class webpackUniversalApps {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;

    this.commands = {
      'build-all': {
        usage: 'Fire the build-front and the build-back commands sequentially',
        lifecycleEvents: [
          'buildFront',
          'buildBack',
          'copySlsYmlFile'
        ]
      },

      'mount-server': { // TODO: May be replaced by start, or think about a command build + start and a single start
        usage: 'Mount a server the will invoke your lambdas locally',
        options: {
          port: {
            usage: '--port <PORT>',
            required: false,
            shortcut: 'p',
          },
        },
        lifecycleEvents: [

        ]
      },

      deploy: {
        usage: 'Deploy the current built package',
        lifecycleEvents: [

        ]
      },

      'build-front': {
        usage: 'Build the frontend bundle',
        lifecycleEvents: [
          'buildFront'
        ]
      },

      'build-back': {
        usage: 'Build the backend bundle',
        lifecycleEvents: [
          'buildBack',
          'copySlsYmlFile'
        ]
      },

      start: {
        usage: 'Fire the build and the mount-server commands sequentially',
        options: {
          port: {
            usage: '--port <PORT>',
            required: false,
            shortcut: 'p',
          },
        },
        lifecycleEvents: [
          'buildFront',
          'buildBack',
          'mountServer'
        ]
      }
    };

    this.hooks = {
      //'before:package:createDeploymentArtifacts': this.compile.bind(this),

      'start:buildFront': this.buildFront.bind(this),
      'start:buildBack': this.buildBack.bind(this),
      'start:mountServer': this.mountServer.bind(this),

      'build-all:copySlsYmlFile': this.copySlsYmlFile.bind(this),
      'build-all:buildFront': this.buildFront.bind(this),
      'build-all:buildBack': this.buildBack.bind(this),

      'build-back:copySlsYmlFile': this.copySlsYmlFile.bind(this),
      'build-front:buildFront': this.buildFront.bind(this),
      'build-back:buildBack': this.buildBack.bind(this)
    };
  }

  copySlsYmlFile() {
    return new Promise( (resolve, reject) => {
      fs.createReadStream(path.resolve(__dirname, '../../serverless.yml'))
        .pipe(fs.createWriteStream(`${this.serverless.service.custom.serverOutputPath}/serverless.yml`))
        .on('finish', () => {
          console.log(`|--> serverless.yml file dopied in ${this.serverless.service.custom.serverOutputPath} folder`);
          resolve();
        })
        .on('error', (err) => {
          console.error(`|--> serverless.yml file could not be copied in ${this.serverless.service.custom.serverOutputPath} folder: ${err}`);
          reject(err);
        });
      });
  }

  buildBack() {
    return new Promise( (resolve, reject) => {
      console.log('Build Server Bundle...');

      const webpackConf = require(this.serverless.service.custom.serverInputPath);
      const compiler = webpack(webpackConf);

      compiler.apply(
        new ProgressPlugin( (percentage, msg) => {
          process.stdout.clearLine();
          process.stdout.cursorTo(0);
          process.stdout.write('Server --> ' + (percentage * 100) + '%: ' + msg);
        })
      );

      compiler.run( (err, stats) => {
        if (err) {
          console.error('ERR = ', err);
          return reject(err);
        }

        console.log('-> compilation done: ' + stats.toString(statOptions));

        resolve();
      });
    });
  }

  buildFront() {
    return new Promise( (resolve, reject) => {
      console.log('Build Front Bundle...');

      const webpackConf = require(this.serverless.service.custom.frontInputPath);
      const compiler = webpack(webpackConf);

      compiler.apply(
        new ProgressPlugin( (percentage, msg) => {
          process.stdout.clearLine();
          process.stdout.cursorTo(0);
          process.stdout.write('Front --> ' + (percentage * 100) + '%: ' + msg);
        })
      );

      compiler.run( (err, stats) => {
        if (err) {
          console.error('ERR = ', err);
          return reject(err);
        }

        console.log('-> compilation done: ' + stats.toString(statOptions));

        resolve();
      });
    });
  }


  mountServer() {
    console.log('Mount Routes...');

    restartApp();

    const routes = getRoutesFromYml(this.serverless.service.custom.serverOutputPath);

    console.log('routes parsed from yml...', routes)

    routes.forEach( route => {
      app[route.method.toLowerCase()](`/${route.path}`, wrapLambdaSignature.bind(null, route.handler));
      console.log(`ROUTE ${route.method} http://localhost:${PORT}/${route.path} mounted !`);
    });
  }
}

module.exports = webpackUniversalApps;
