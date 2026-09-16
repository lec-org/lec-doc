import { Injectable } from '@nestjs/common';
import { EnvironmentService } from './environment.service';

@Injectable()
export class LicenseCheckService {
  constructor(private readonly environmentService: EnvironmentService) {}

  isValidEELicense(_licenseKey: string): boolean {
    return this.environmentService.isCloud();
  }

  hasFeature(
    _licenseKey: string,
    _feature: string,
    _plan?: string,
  ): boolean {
    return false;
  }

  getFeatures(_licenseKey: string): string[] {
    return [];
  }

  resolveFeatures(_licenseKey: string, _plan: string): string[] {
    return [];
  }

  resolveTier(_licenseKey: string, plan: string): string {
    return this.environmentService.isCloud() ? (plan ?? 'standard') : 'free';
  }
}
