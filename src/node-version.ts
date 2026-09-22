// renovate: datasource=docker depName=node versioning=semver
export const NODE_VERSION = "24.21.0";

export const NODE_MINIMUM_VERSION = NODE_VERSION.split(".").map(Number) as [
  number,
  number,
  number,
];

export const NODE_VERSION_REQUIREMENT = `${NODE_VERSION} or later`;
