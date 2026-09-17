import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** Loads a private trust anchor explicitly; malformed or non-CA PEM fails startup/use. */
export function loadInternalCa(file: string): string {
  const pem = readFileSync(file, 'utf8');
  const blocks = pem.match(
    /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
  );
  if (
    !blocks?.length ||
    pem
      .replace(
        /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
        '',
      )
      .trim()
  ) {
    throw new Error('LEC_INTERNAL_CA_FILE must contain only PEM certificates');
  }
  for (const block of blocks) {
    if (!new X509Certificate(block).ca) {
      throw new Error('LEC_INTERNAL_CA_FILE contains a non-CA certificate');
    }
  }
  return blocks.join('\n');
}
