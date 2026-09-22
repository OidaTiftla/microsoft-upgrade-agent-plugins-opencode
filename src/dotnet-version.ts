// renovate: datasource=docker depName=mcr.microsoft.com/dotnet/sdk versioning=docker
export const DOTNET_VERSION = "10.0.401";

export const DOTNET_MINIMUM_MAJOR = Number(DOTNET_VERSION.split(".", 1)[0]);
export const DOTNET_VERSION_REQUIREMENT = `${DOTNET_MINIMUM_MAJOR} or later`;
