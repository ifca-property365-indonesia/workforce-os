/**
 * DNS for tests (vi.mock("node:dns/promises") → fakeLookup): no network. Hosts under *.private.test answer a private
 * address, metadata.test the cloud metadata one, *.nxdomain.test nothing at all; everything else a public address.
 */
export async function fakeLookup(host: string): Promise<{ address: string; family: number }[]> {
  if (host.endsWith(".nxdomain.test")) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
  if (host.endsWith(".private.test")) return [{ address: "10.0.0.5", family: 4 }];
  if (host === "metadata.test") return [{ address: "169.254.169.254", family: 4 }];
  return [{ address: "93.184.216.34", family: 4 }];
}

export const dnsModule = async (orig: () => Promise<typeof import("node:dns/promises")>) => {
  const real = await orig();
  const lookup = (host: string) => fakeLookup(host);
  return { ...real, lookup, default: { ...real, lookup } };
};
