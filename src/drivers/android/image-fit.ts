export interface ImageFitInput {
  readonly apiLevel: string;
  readonly tag: string;
  readonly tags: readonly string[];
}

export function isPlayStoreImage(_image: ImageFitInput): boolean {
  return false;
}
