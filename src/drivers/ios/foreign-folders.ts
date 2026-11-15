export interface ForeignFolders {
  readonly deviceSet: string;
  readonly sourcesSet: string;
  readonly logsRoot: string;
  readonly ownUdid: string;
}

export function swapForeignFolders(bytes: Uint8Array, _folders: ForeignFolders): Uint8Array {
  return bytes;
}
