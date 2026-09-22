// renovate: datasource=docker depName=node versioning=semver
export const NODE_VERSION = "24.21.0";

export const NODE_MINIMUM_MAJOR = Number(NODE_VERSION.split(".", 1)[0]);

export const NODE_VERSION_REQUIREMENT = `${NODE_MINIMUM_MAJOR} or later`;
