const assert = require('assert');
const axios = require('axios');
const debug = require('debug');
const fs = require('fs');
const path = require('path');
const decryptData = require('./crypto');

const modules = fs.readdirSync(path.join(__dirname, '/modules')).filter(f => f.endsWith('.js')).map(f => f.replace(/.js$/, ''));

axios.defaults.baseURL = 'https://api.weixin.qq.com';
axios.interceptors.request.use((config) => {
  const { method, url, params } = config;
  debug('mp-sdk:request')(`${method.toUpperCase()} ${url}`);
  debug('mp-sdk:request')(params);
  return config;
}, error => Promise.reject(error));

axios.interceptors.response.use(({ data }) => {
  debug('mp-sdk:response')(data);
  return data;
}, error => Promise.reject(error));

let globalToken = {
  token: '',
  expires: 0
};

module.exports = (appid, secret, getAccessTokenFromStore = null, setAccessTokenToStore = null) => {
  assert.ok(appid, 'The 1st param `appid` is required.');
  assert.ok(secret, 'The 2nd param `secret` is required.');

  const getAccessToken = () => {
    let tokenData = globalToken;
    if (getAccessTokenFromStore) tokenData = getAccessTokenFromStore();
    if (tokenData.expires > new Date()) {
      return Promise.resolve(tokenData.token);
    }
    return axios.get('/cgi-bin/token', {
      params: {
        grant_type: 'client_credential', appid, secret
      }
    }).then(({ access_token: token = '', expires_in: expires = 0 }) => {
      globalToken = {
        token,
        expires: new Date() + (expires - 2e2) * 1e3
      };
      if (setAccessTokenToStore) setAccessTokenToStore(globalToken);
      return token;
    });
  };

  const makeRequest = ({ url, data = {}, module, params = {} }) => getAccessToken()
    .then(token => axios.post(url, data, { params: { access_token: token, ...params }, ...(module === 'wxacode' ? { responseType: 'arraybuffer' } : {}) }));

  const originObj = {
    crypto: {
      decryptData: decryptData(appid)
    },
    auth: {
      code2Session: params => axios.get('/sns/jscode2session', {
        params: {
          appid, secret, grant_type: 'authorization_code', ...params
        }
      }),
      getAccessToken,
      getPaidUnionId: params => getAccessToken().then(token => axios.get('https://api.weixin.qq.com/wxa/getpaidunionid',
        { params: { access_token: token, ...params } }))
    }
  };
  return new Proxy(originObj, {
    get: (obj, target) => {
      const module = target.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(obj, module)) {
        return obj[module];
      }
      if (modules.indexOf(module) !== -1) {
        const loadModule = methods => Object.keys(methods).reduce((o, method) => {
          Object.assign(o, {
            [method]: (data, params = {}) => makeRequest({ url: methods[method], data, module, params })
          });
          return o;
        }, {});
        Object.assign(obj, {
          // eslint-disable-next-line global-require,import/no-dynamic-require
          [module]: loadModule(require(`./modules/${module}`))
        });
        return obj[module];
      }
      return assert.fail('No such module.');
    }
  });
};
