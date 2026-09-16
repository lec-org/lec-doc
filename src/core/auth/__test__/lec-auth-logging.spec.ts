import { redactSensitiveUrl } from '../../../common/helpers/utils';

describe('OIDC 日志脱敏', () => {
  it('HTTP 请求日志不记录 callback code、state 或 IdP 错误详情', () => {
    expect(
      redactSensitiveUrl(
        '/api/auth/oidc/callback?code=private-code&state=private-state&error_description=private-description',
      ),
    ).toBe('/api/auth/oidc/callback');
  });
});
