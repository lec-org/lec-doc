import { rootCertificates } from 'node:tls';
import { readFileSync } from 'node:fs';
import { loadInternalCa } from './internal-ca';

jest.mock('node:fs', () => ({
  ...jest.requireActual('node:fs'),
  readFileSync: jest.fn(),
}));

const read = readFileSync as jest.MockedFunction<typeof readFileSync>;

describe('loadInternalCa', () => {
  it('loads a PEM CA certificate', () => {
    read.mockReturnValue(rootCertificates[0]);

    expect(loadInternalCa('/run/secrets/lec-internal-ca.pem')).toContain(
      '-----BEGIN CERTIFICATE-----',
    );
  });

  it.each(['not a certificate', '', `${rootCertificates[0]}\ntrailing-data`])(
    'fails closed for malformed CA content',
    (pem) => {
      read.mockReturnValue(pem);
      expect(() =>
        loadInternalCa('/run/secrets/lec-internal-ca.pem'),
      ).toThrow();
    },
  );
});
