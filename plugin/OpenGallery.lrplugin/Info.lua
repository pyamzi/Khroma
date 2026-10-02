-- Khroma for Lightroom Classic: a Publish Service that mirrors projects as collections,
-- uploads finals as drafts keyed to their RAW, pulls client picks and comments, and reports progress.
return {
  LrSdkVersion = 6.0,
  LrSdkMinimumVersion = 6.0,
  LrToolkitIdentifier = 'app.opengallery.lightroom',
  LrPluginName = 'Khroma',
  LrPluginInfoUrl = 'https://khroma.ink',
  LrInitPlugin = 'OGInit.lua',
  LrExportServiceProvider = {
    title = 'Khroma',
    file = 'OGPublishProvider.lua',
  },
  LrLibraryMenuItems = {
    { title = 'Send for culling to Khroma…', file = 'OGSendCulling.lua' },
    { title = 'Khroma: Sync picks', file = 'OGSyncPicks.lua' },
    { title = 'Khroma: Report editing progress', file = 'OGProgress.lua' },
  },
  VERSION = { major = 0, minor = 1, revision = 0, build = 'm4' },
}
