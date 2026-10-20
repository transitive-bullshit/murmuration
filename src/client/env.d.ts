interface ImportMetaEnv {
  /** decoded size of data/dataset.json, set by production builds */
  readonly MURMURATION_DATASET_BYTES?: number
  /** published dataset path with its content hash, set by production builds */
  readonly MURMURATION_DATASET_PATH?: string
}
