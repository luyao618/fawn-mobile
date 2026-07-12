export const ROUTES = {
  steward: "StewardTab",
  records: "RecordsTab",
  growth: "GrowthTab",
  album: "AlbumTab",
  me: "MeTab",
} as const;

export type RootTabParamList = {
  StewardTab: undefined;
  RecordsTab: undefined;
  GrowthTab: undefined;
  AlbumTab: undefined;
  MeTab: undefined;
};
