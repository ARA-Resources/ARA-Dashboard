import type { BusinessUnitId } from "./home-widgets.js";
import type { DatasetSyncName } from "./dataset-sync.js";

export type CurrentDatasetFile = {
  datasetName: DatasetSyncName;
  businessUnitId: BusinessUnitId;
  filePath: string;
  fileName: string;
  mtimeMs: number;
  size: number;
  source: "dataset-manager";
};

export type DatasetCurrentGetResponse = {
  datasets: Array<{
    datasetName: DatasetSyncName;
    businessUnitId: BusinessUnitId;
    fileName: string;
    filePath: string;
    mtimeMs: number;
    size: number;
    source: "dataset-manager";
    updatedAt: string;
  }>;
};
