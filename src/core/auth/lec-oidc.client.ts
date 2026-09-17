import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isEmail } from 'class-validator';
import * as oidc from 'openid-client';
import { fetch } from 'undici';
import { OutboundAgentFactory } from '../../integrations/outbound/outbound-agent.factory';
import { loadInternalCa } from '../../integrations/outbound/internal-ca';

export type LecOidcTransaction = {
  state: string;
  nonce: string;
  verifier: string;
};
export type LecOidcPrincipal = {
  issuer: string;
  subject: string;
  email: string;
  name: string;
};

/** 只处理 LecSSO 协议；一次性事务和本地会话由认证服务持有。 */
@Injectable()
export class LecOidcClient {
  private readonly caCert: string;

  constructor(
    private readonly config: ConfigService,
    private readonly agents: OutboundAgentFactory,
  ) {
    this.caCert = loadInternalCa(
      this.config.getOrThrow<string>('LEC_INTERNAL_CA_FILE'),
    );
  }

  private get issuer(): URL {
    return this.httpsUrl(this.config.getOrThrow<string>('LEC_DOC_OIDC_ISSUER'));
  }

  private get callback(): string {
    const app = this.httpsUrl(this.config.getOrThrow<string>('APP_URL'));
    if (app.pathname !== '/') throw new Error('APP_URL 必须是精确 origin');
    return `${app.origin}/api/auth/oidc/callback`;
  }

  private httpsUrl(value: string): URL {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    ) {
      throw new Error('OIDC 地址必须使用 HTTPS，且不能包含凭据、查询或片段');
    }
    return url;
  }

  private async configuration(): Promise<oidc.Configuration> {
    const issuer = this.issuer;
    const configuration = await oidc.discovery(
      issuer,
      'lec-doc',
      {
        client_secret: this.config.getOrThrow<string>('LEC_DOC_CLIENT_SECRET'),
        id_token_signed_response_alg: 'RS256',
        [oidc.clockTolerance]: 5,
      },
      undefined,
      {
        timeout: 10,
        execute: [oidc.enableNonRepudiationChecks],
        [oidc.customFetch]: async (input, init) => {
          // discovery/token/JWKS 都固定在配置的 IdP origin；每次连接复用 DNS 防护。
          const url = this.httpsUrl(String(input));
          if (url.origin !== issuer.origin)
            throw new Error('OIDC endpoint origin 不匹配');
          const lease = await this.agents.lease(url.href, {
            caCert: this.caCert,
          });
          try {
            const response = await fetch(url, {
              ...init,
              dispatcher: lease.dispatcher,
              redirect: 'error',
            });
            const chunks: Uint8Array[] = [];
            let size = 0;
            for await (const chunk of response.body) {
              size += chunk.byteLength;
              if (size > 1024 * 1024) throw new Error('OIDC 响应超出大小限制');
              chunks.push(chunk);
            }
            return new Response(Buffer.concat(chunks), {
              status: response.status,
              headers: Object.fromEntries(response.headers),
            });
          } finally {
            await lease.release();
          }
        },
      },
    );
    const metadata = configuration.serverMetadata();
    for (const endpoint of [
      metadata.authorization_endpoint,
      metadata.token_endpoint,
      metadata.jwks_uri,
    ]) {
      if (!endpoint || this.httpsUrl(endpoint).origin !== issuer.origin) {
        throw new Error('OIDC endpoint origin 不匹配');
      }
    }
    if (!metadata.code_challenge_methods_supported?.includes('S256')) {
      throw new Error('LecSSO 必须支持 PKCE S256');
    }
    return configuration;
  }

  async identityFromAccessToken(
    accessToken: string,
  ): Promise<LecOidcPrincipal> {
    if (!accessToken || accessToken.length > 8192)
      throw new UnauthorizedException('访问令牌无效');
    const config = await this.configuration();
    const metadata = config.serverMetadata();
    if (
      !metadata.userinfo_endpoint ||
      this.httpsUrl(metadata.userinfo_endpoint).origin !== this.issuer.origin
    )
      throw new UnauthorizedException('LecSSO userinfo endpoint 无效');
    const profile = await oidc.fetchUserInfo(
      config,
      accessToken,
      oidc.skipSubjectCheck,
    );
    if (
      !profile.sub ||
      profile.sub.length > 255 ||
      profile.email_verified !== true ||
      typeof profile.email !== 'string' ||
      !isEmail(profile.email)
    )
      throw new UnauthorizedException('登录身份或已验证邮箱无效');
    return {
      issuer: this.issuer.href,
      subject: profile.sub,
      email: profile.email.toLowerCase(),
      name:
        typeof profile.name === 'string' && profile.name.trim()
          ? profile.name.slice(0, 255)
          : profile.email,
    };
  }

  async begin(): Promise<{ url: string; transaction: LecOidcTransaction }> {
    const config = await this.configuration();
    const transaction = {
      state: oidc.randomState(),
      nonce: oidc.randomNonce(),
      verifier: oidc.randomPKCECodeVerifier(),
    };
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: this.callback,
      scope: 'openid profile email',
      code_challenge_method: 'S256',
      code_challenge: await oidc.calculatePKCECodeChallenge(
        transaction.verifier,
      ),
      state: transaction.state,
      nonce: transaction.nonce,
    });
    return { url: url.href, transaction };
  }

  async complete(
    url: URL,
    transaction: LecOidcTransaction,
  ): Promise<LecOidcPrincipal> {
    if (
      url.origin + url.pathname !== this.callback ||
      url.hash ||
      url.username ||
      url.password
    ) {
      throw new UnauthorizedException('登录回调地址不匹配');
    }
    const config = await this.configuration();
    const tokens = await oidc.authorizationCodeGrant(config, url, {
      pkceCodeVerifier: transaction.verifier,
      expectedState: transaction.state,
      expectedNonce: transaction.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    const now = Math.floor(Date.now() / 1000);
    if (
      !claims ||
      !claims.sub ||
      claims.sub.length > 255 ||
      (claims.azp !== undefined && claims.azp !== 'lec-doc') ||
      !Number.isFinite(claims.iat) ||
      claims.iat > now + 5 ||
      claims.iat < now - 600 ||
      claims.email_verified !== true ||
      typeof claims.email !== 'string' ||
      !isEmail(claims.email)
    ) {
      throw new UnauthorizedException('登录身份或已验证邮箱无效');
    }
    // access/refresh token 不进入浏览器响应，也不充当 Doc 的授权缓存。
    return {
      issuer: this.issuer.href,
      subject: claims.sub,
      email: claims.email.toLowerCase(),
      name:
        typeof claims.name === 'string' && claims.name.trim()
          ? claims.name.slice(0, 255)
          : claims.email,
    };
  }
}
