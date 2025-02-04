import OAuthClient from './OAuthClient'
import AccessToken from './AccessToken'

const CLIENT_INIT_OPTIONS = {
  uri: 'http://cozy.tools:8080',
  oauth: {
    clientName: 'TestClientName',
    softwareID: 'TestSofwareID',
    redirectURI: 'http://localhost'
  }
}

const REGISTERED_CLIENT_INIT_OPTIONS = {
  uri: CLIENT_INIT_OPTIONS.uri,
  oauth: {
    ...CLIENT_INIT_OPTIONS.oauth,
    clientID: '1',
    clientsecret: '1',
    registrationAccessToken: 'registrationAccessToken-1234'
  }
}

describe('OAuthClient', () => {
  beforeAll(() => {
    global.fetch = require('jest-fetch-mock')
  })

  beforeEach(() => {
    fetch.resetMocks()
    fetch.mockResponse(JSON.stringify({ foo: 'bar' }))
  })

  let client

  describe('without registration', () => {
    beforeEach(() => {
      client = new OAuthClient(CLIENT_INIT_OPTIONS)
    })

    it('should register a client', () => {
      client.register()
      expect(fetch.mock.calls[0]).toMatchSnapshot()
    })

    it('should throw on other server interactions', () => {
      expect(client.unregister()).rejects.toThrowErrorMatchingSnapshot()
      expect(client.fetchInformation()).rejects.toThrowErrorMatchingSnapshot()
      expect(client.updateInformation()).rejects.toThrowErrorMatchingSnapshot()
      expect(client.fetchAccessToken()).rejects.toThrowErrorMatchingSnapshot()
      expect(client.refreshToken()).rejects.toThrowErrorMatchingSnapshot()
    })

    it('should not generate a auth code URL', () => {
      expect(() => {
        client.getAuthCodeURL('statecode')
      }).toThrowErrorMatchingSnapshot()
    })
  })

  describe('with registration', () => {
    beforeEach(() => {
      client = new OAuthClient(REGISTERED_CLIENT_INIT_OPTIONS)
      client.setToken({
        tokenType: 'type',
        accessToken: 'accessToken-abcd',
        refreshToken: 'refresh-789',
        scope: 'io.cozy.todos'
      })
    })

    it('should throw when trying to register again', () => {
      expect(client.register()).rejects.toThrowErrorMatchingSnapshot()
    })

    it('should unregister a client', () => {
      expect(client.isRegistered()).toBeTruthy()
      client.unregister()
      expect(fetch.mock.calls[0]).toMatchSnapshot()
      expect(client.isRegistered()).toBeFalsy()
    })

    it('should fetch client informations', () => {
      client.fetchInformation()
      expect(fetch.mock.calls[0]).toMatchSnapshot()
    })

    it('should update client informations', () => {
      client.updateInformation({
        policy_url: 'http://example.com'
      })
      expect(fetch.mock.calls[0]).toMatchSnapshot()
    })

    it('should generate a random state code', () => {
      expect(client.generateStateCode()).toBeDefined()
    })

    it('should generate the auth code URL', () => {
      expect(
        client.getAuthCodeURL('randomstatetoken', ['io.cozy.todos'])
      ).toEqual(
        `${REGISTERED_CLIENT_INIT_OPTIONS.uri}/auth/authorize?client_id=${
          REGISTERED_CLIENT_INIT_OPTIONS.oauth.clientID
        }&redirect_uri=${encodeURIComponent(
          REGISTERED_CLIENT_INIT_OPTIONS.oauth.redirectURI
        )}&state=randomstatetoken&response_type=code&scope=io.cozy.todos`
      )
    })

    it('should generate the auth code URL even with registerToken', () => {
      const oauthOptions = {
        ...REGISTERED_CLIENT_INIT_OPTIONS,
        oauth: {
          ...REGISTERED_CLIENT_INIT_OPTIONS.oauth,
          registerToken: 'AZERTY'
        }
      }
      const newClient = new OAuthClient(oauthOptions)
      newClient.setToken({
        tokenType: 'type',
        accessToken: 'accessToken-abcd',
        refreshToken: 'refresh-789',
        scope: 'io.cozy.todos'
      })
      expect(
        newClient.getAuthCodeURL('randomstatetoken', ['io.cozy.todos'])
      ).toEqual(
        `${REGISTERED_CLIENT_INIT_OPTIONS.uri}/auth/authorize?client_id=${
          REGISTERED_CLIENT_INIT_OPTIONS.oauth.clientID
        }&redirect_uri=${encodeURIComponent(
          REGISTERED_CLIENT_INIT_OPTIONS.oauth.redirectURI
        )}&state=randomstatetoken&response_type=code&scope=io.cozy.todos&registerToken=AZERTY`
      )
    })

    it('should get the access code from an URL', () => {
      const stateCode = 'myrandomcode'
      const accessCode = 'myaccesscode'
      const url = `http://example.com?state=${stateCode}&access_code=${accessCode}`
      expect(client.getAccessCodeFromURL(url, stateCode)).toEqual(accessCode)
    })

    it('should throw when no access code is provided', () => {
      expect(() => {
        client.getAccessCodeFromURL('http://example.com')
      }).toThrowErrorMatchingSnapshot()
    })

    it('should throw when the provided access code is different from the URL', () => {
      const stateCode = 'myrandomcode'
      const accessCode = 'myaccesscode'
      const url = `http://example.com?state=${stateCode}&access_code=${accessCode}`

      expect(() => {
        client.getAccessCodeFromURL(url, 'incorrect')
      }).toThrowErrorMatchingSnapshot()
    })

    it('should fetch an access token', () => {
      client.fetchAccessToken('myaccesstoken')
      expect(fetch.mock.calls[0]).toMatchSnapshot()
    })

    it('should refresh the access token', () => {
      client.refreshToken()
      expect(fetch.mock.calls[0]).toMatchSnapshot()
    })

    it('should automatically refresh the token after a failed fetch', async () => {
      fetch.mockRejectOnce(new Error('Expired token'))
      const spy = jest.spyOn(client, 'refreshToken')
      await client.fetchJSON('GET', '/foo')
      expect(spy).toHaveBeenCalled()
    })

    it('should throw when refreshing the access token without token', () => {
      client = new OAuthClient(REGISTERED_CLIENT_INIT_OPTIONS)
      expect(client.refreshToken()).rejects.toThrowErrorMatchingSnapshot()
    })

    it('should update the internal credentials', () => {
      const camelCredentials = {
        tokenType: 'Camel',
        accessToken: 'Cased',
        refreshToken: 'refresh-me',
        scope: 'io.cozy.todos'
      }
      const snakeCredentials = {
        token_type: 'Snake',
        access_token: 'DoubleCased',
        refresh_token: 'refresh-you',
        scope: 'io.cozy.todos'
      }
      client.setToken(camelCredentials)
      expect(client.token).toBeInstanceOf(AccessToken)
      expect(client.token.tokenType).toEqual(camelCredentials.tokenType)
      expect(client.token.accessToken).toEqual(camelCredentials.accessToken)
      expect(client.token.refreshToken).toEqual(camelCredentials.refreshToken)
      expect(client.token.scope).toEqual(camelCredentials.scope)

      client.setToken(JSON.stringify(snakeCredentials))
      expect(client.token).toBeInstanceOf(AccessToken)
      expect(client.token.tokenType).toEqual(snakeCredentials.token_type)
      expect(client.token.accessToken).toEqual(snakeCredentials.access_token)
      expect(client.token.refreshToken).toEqual(snakeCredentials.refresh_token)
      expect(client.token.scope).toEqual(snakeCredentials.scope)
    })

    it('should reset the client', () => {
      client.setUri('test')
      expect(client.uri).toEqual('test')
      client.resetClient()
      expect(client.uri).toBeNull()
      expect(client.oauthOptions.clientID).toEqual('')
      expect(client.token).toBeNull()
    })
  })

  describe('getAccessToken', () => {
    it('should return the current access token', () => {
      client = new OAuthClient(REGISTERED_CLIENT_INIT_OPTIONS)
      client.setToken({
        tokenType: 'type',
        accessToken: 'accessToken-abcd',
        refreshToken: 'refresh-789',
        scope: 'io.cozy.todos'
      })
      expect(client.getAccessToken()).toBe('accessToken-abcd')
    })
  })
})
