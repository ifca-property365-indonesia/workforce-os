export declare const HASH_LENGTH: number;
export declare const HASHES_FILE: string;
export declare function sourceHash(text: string): string;
export type CatalogTree = { [k: string]: string | CatalogTree };
export declare function flattenCatalog(tree: CatalogTree, prefix?: string): Map<string, string>;
export declare function loadEnglish(webRoot: string): Map<string, string>;
export declare function loadHashes(webRoot: string): Record<string, string>;
export declare function checkSourceHashes(english: Map<string, string>, stored: Record<string, string>): { stale: string[]; missing: string[]; orphaned: string[] };
export declare function rehash(english: Map<string, string>, stored: Record<string, string>, opts?: { only?: string[]; prune?: boolean; pruneOnly?: boolean }): Record<string, string>;
