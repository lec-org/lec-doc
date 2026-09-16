import { Injectable } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const packageJson = require('./../../../package.json');

@Injectable()
export class VersionService {
  constructor() {}

  getVersion() {
    return {
      currentVersion: packageJson?.version,
      latestVersion: packageJson?.version,
      releaseUrl: 'https://github.com/lec-org/lec-doc/releases',
    };
  }
}
