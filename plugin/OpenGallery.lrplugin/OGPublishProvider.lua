-- Export service provider + publish support for OpenGallery.
local LrView = import 'LrView'
local LrDialogs = import 'LrDialogs'
local LrTasks = import 'LrTasks'
local LrPathUtils = import 'LrPathUtils'
local LrApplication = import 'LrApplication'
local LrErrors = import 'LrErrors'
local LrLogger = import 'LrLogger'
local logger = LrLogger('Khroma'); logger:enable('logfile')

local OGApi = require 'OGApi'
local OGHttp = require 'OGLrHttp'
local OGUtil = require 'OGUtil'
local bind = LrView.bind

local provider = {}

-- Publish-only, JPEG finals into the project's draft area.
provider.supportsIncrementalPublish = 'only'
provider.allowFileFormats = { 'JPEG' }
provider.allowColorSpaces = { 'sRGB' }
provider.hideSections = { 'exportLocation', 'video', 'watermarking' }
provider.canExportVideo = false
provider.hidePrintResolution = true
provider.exportPresetFields = {
  { key = 'serverUrl', default = '' },
  { key = 'token', default = '' },
  { key = 'mountPath', default = '' },
}
provider.small_icon = nil
provider.titleForGoToPublishedCollection = 'Open in Khroma'
provider.titleForGoToPublishedPhoto = 'Open in Khroma'

local function api(settings)
  return OGApi.new{ baseUrl = OGUtil.trim(settings.serverUrl), token = OGUtil.trim(settings.token), http = OGHttp }
end
provider.api = api

-- Settings dialog ----------------------------------------------------------------------------
function provider.sectionsForTopOfDialog(f, propertyTable)
  local status = LrView.share('og_status')
  return {
    {
      title = 'Khroma server',
      f:row { f:static_text { title = 'Server URL', width = LrView.share('og_label') }, f:edit_field { value = bind 'serverUrl', width_in_chars = 40, immediate = true } },
      f:row { f:static_text { title = 'Plugin token', width = LrView.share('og_label') }, f:password_field { value = bind 'token', width_in_chars = 40, immediate = true } },
      f:row { f:static_text { title = 'NAS mount path', width = LrView.share('og_label') }, f:edit_field { value = bind 'mountPath', width_in_chars = 34, immediate = true },
        f:push_button { title = 'Browse…', action = function()
          local dir = LrDialogs.runOpenPanel { title = 'Choose the mounted Photos share', canChooseFiles = false, canChooseDirectories = true, allowsMultipleSelection = false }
          if dir and dir[1] then propertyTable.mountPath = dir[1] end
        end } },
      f:row { f:push_button { title = 'Verify connection', action = function()
          LrTasks.startAsyncTask(function()
            local me, err = api(propertyTable):me()
            if me then propertyTable.og_status = 'Connected to ' .. tostring(me.studio) .. ' as "' .. tostring(me.name) .. '" (' .. tostring(me.scope) .. ')'
            else propertyTable.og_status = 'Not connected: ' .. tostring(err) end
          end)
        end },
        f:static_text { title = bind 'og_status', width_in_chars = 50, fill_horizontal = 1 } },
      f:static_text { title = 'Finals publish into the project\'s draft area; nothing reaches the client until you publish to client. Turn on "Automatically write changes into XMP" so other photographers see your edits.', width_in_chars = 70, height_in_lines = 2 },
    },
  }
end

-- Publish collections mirror projects -------------------------------------------------------------
function provider.getCollectionBehaviorInfo(publishSettings)
  return { defaultCollectionName = 'Finals', defaultCollectionCanBeDeleted = true, canAddCollection = true, maxCollectionSetDepth = 0 }
end

function provider.viewForCollectionSettings(f, publishSettings, info)
  local cs = info.collectionSettings
  cs.projectId = cs.projectId or ''
  cs.projectTitle = cs.projectTitle or ''
  cs.folderPath = cs.folderPath or ''
  cs.projectItems = cs.projectItems or {}
  cs.newTitle = cs.newTitle or ''
  cs.clientItems = cs.clientItems or {}
  cs.clientId = cs.clientId or ''
  LrTasks.startAsyncTask(function()
    local a = api(publishSettings)
    local projects = a:projects() or {}
    local items = {}
    for _, p in ipairs(projects) do items[#items + 1] = { title = p.title .. '  ·  ' .. tostring(p.client), value = p.id .. '|' .. p.folderPath .. '|' .. p.title } end
    cs.projectItems = items
    local clients = a:clients() or {}
    local citems = {}
    for _, c in ipairs(clients) do citems[#citems + 1] = { title = c.name, value = c.id } end
    cs.clientItems = citems
  end)
  return f:column {
    bind_to_object = cs, spacing = f:control_spacing(),
    f:static_text { title = 'Project', font = '<system/bold>' },
    f:popup_menu { value = bind 'projectChoice', items = bind 'projectItems', width_in_chars = 40 },
    f:static_text { title = 'or create a new project', font = '<system/small>' },
    f:row { f:popup_menu { value = bind 'clientId', items = bind 'clientItems', width_in_chars = 18 }, f:edit_field { value = bind 'newTitle', placeholder_string = 'New project title', width_in_chars = 22 } },
    f:static_text { title = 'Stage: Finals (culling renditions arrive in a later release)', font = '<system/small>' },
  }
end

function provider.endDialogForCollectionSettings(publishSettings, info)
  local cs = info.collectionSettings
  if cs.projectChoice and cs.projectChoice ~= '' then
    local id, folder, title = cs.projectChoice:match('^([^|]+)|([^|]*)|(.*)$')
    cs.projectId, cs.folderPath, cs.projectTitle = id, folder, title
  elseif OGUtil.trim(cs.newTitle) ~= '' and cs.clientId ~= '' then
    local r, err = api(publishSettings):createProject(cs.clientId, OGUtil.trim(cs.newTitle))
    if not r then LrErrors.throwUserError('Could not create the project: ' .. tostring(err)) end
    cs.projectId, cs.folderPath, cs.projectTitle = r.id, r.folderPath, r.title
  end
  if not cs.projectId or cs.projectId == '' then LrErrors.throwUserError('Choose a project for this collection, or create one.') end
end
provider.updateCollectionSettings = function() end

function provider.validatePublishedCollectionName(name) return OGUtil.trim(name) ~= '', 'Give the collection a name' end

-- Find the collection settings for the collection being published.
local function collectionSettings(exportContext)
  local info = exportContext.publishedCollectionInfo
  local coll = info and info.publishedCollection
  if coll and coll.getCollectionInfoSummary then
    local ok, summary = pcall(function() return coll:getCollectionInfoSummary() end)
    if ok and summary and summary.collectionSettings then return summary.collectionSettings end
  end
  return {}
end

-- Source id: stored per catalog photo after the first path lookup.
local function sourceIdFor(a, catalog, photo, cs, mountPath)
  local stored = photo:getPropertyForPlugin(_PLUGIN, 'ogSourceId', nil, true)
  if stored and stored ~= '' then return stored end
  local rel = OGUtil.relativeToProject(mountPath, cs.folderPath or '', photo:getRawMetadata('path') or '')
  if not rel then return nil end
  local map = a:resolve(cs.projectId, { rel })
  local id = map and map[rel]
  if id then
    catalog:withPrivateWriteAccessDo(function() photo:setPropertyForPlugin(_PLUGIN, 'ogSourceId', id); photo:setPropertyForPlugin(_PLUGIN, 'ogProjectId', cs.projectId) end)
    return id
  end
  return nil
end

-- Publish: render, upload as draft, record the remote id ------------------------------------------
function provider.processRenderedPhotos(functionContext, exportContext)
  local exportSession = exportContext.exportSession
  local settings = assert(exportContext.propertyTable)
  local cs = collectionSettings(exportContext)
  if not cs.projectId or cs.projectId == '' then LrErrors.throwUserError('This collection is not linked to an Khroma project. Edit the collection settings.') end
  local a = api(settings)
  local catalog = LrApplication.activeCatalog()
  local n = exportSession:countRenditions()
  local progress = exportContext:configureProgress { title = n > 1 and ('Uploading ' .. n .. ' finals to Khroma') or 'Uploading final to Khroma' }
  exportSession:recordRemoteCollectionId(cs.projectId)
  local failures = {}
  for i, rendition in exportContext:renditions { stopIfCanceled = true } do
    progress:setPortionComplete(i - 1, n)
    local photo = rendition.photo
    local ok, path = rendition:waitForRender()
    if progress:isCanceled() then break end
    if ok then
      local sourceId = sourceIdFor(a, catalog, photo, cs, settings.mountPath)
      local name = LrPathUtils.leafName(path)
      local r, err = a:uploadFinal(cs.projectId, { filePath = path, name = name, sourcePhotoId = sourceId, uploadId = OGUtil.uploadId(photo, path) })
      if r then
        rendition:recordPublishedPhotoId(r.photoId)
        catalog:withPrivateWriteAccessDo(function() photo:setPropertyForPlugin(_PLUGIN, 'ogProjectId', cs.projectId) end)
        logger:info('uploaded', name, '->', r.relPath, sourceId and ('source ' .. sourceId) or 'no source link')
      else
        failures[#failures + 1] = name .. ': ' .. tostring(err)
        rendition:uploadFailed(tostring(err))
      end
    else
      failures[#failures + 1] = tostring(path)
    end
  end
  progress:done()
  if #failures > 0 then LrDialogs.message('Some finals were not uploaded', table.concat(failures, '\n'), 'warning') end
end

-- Removing from the collection withdraws a draft; live finals wait for publication tooling.
function provider.deletePhotosFromPublishedCollection(publishSettings, arrayOfPhotoIds, deletedCallback)
  local a = api(publishSettings)
  local kept = {}
  for _, id in ipairs(arrayOfPhotoIds) do
    local ok, err = a:deleteFinal(id)
    if ok then deletedCallback(id) elseif err and err:match('live_until_published') then kept[#kept + 1] = id else LrDialogs.message('Could not remove a final', tostring(err), 'warning') end
  end
  if #kept > 0 then LrDialogs.message(#kept .. ' final(s) are already live for the client', 'They stay published until they are retired from OpenGallery.', 'info') end
end

function provider.shouldDeletePhotosFromServiceOnDeleteFromCatalog(publishSettings, nPhotos) return 'ignore' end
function provider.metadataThatTriggersRepublish(publishSettings) return { default = false, title = false, caption = false, keywords = false, gps = false, dateCreated = false } end

-- Comments panel ----------------------------------------------------------------------------------
function provider.canAddCommentsToService(publishSettings) return true end

function provider.getCommentsFromPublishedCollection(publishSettings, arrayOfPhotoInfo, commentCallback)
  local a = api(publishSettings)
  local byProject = {}
  for _, info in ipairs(arrayOfPhotoInfo) do
    local pid = info.photo:getPropertyForPlugin(_PLUGIN, 'ogProjectId', nil, true)
    if pid and pid ~= '' then byProject[pid] = byProject[pid] or {}; table.insert(byProject[pid], info) end
  end
  for pid, infos in pairs(byProject) do
    local comments = a:comments(pid) or {}
    for _, info in ipairs(infos) do
      local sourceId = info.photo:getPropertyForPlugin(_PLUGIN, 'ogSourceId', nil, true)
      local list = {}
      for _, c in ipairs(comments) do
        if c.photoId == info.remoteId or (sourceId and c.photoId == sourceId) then
          local prefix = (c.hint and c.hint ~= '' and c.hint ~= 'centre') and (tostring(c.hint) .. ': ') or ''
          local tag = (c.photoId == sourceId and c.photoId ~= info.remoteId) and '[on the RAW] ' or ''
          list[#list + 1] = { commentId = c.id, commentText = tag .. prefix .. tostring(c.text) .. (c.resolvedAt and c.resolvedAt ~= '' and ' ✓' or ''), dateCreated = OGUtil.isoToLrTime(c.createdAt), username = c.author, realname = c.author }
        end
      end
      commentCallback { publishedPhoto = info, comments = list }
    end
  end
end

function provider.addCommentToPublishedPhoto(publishSettings, remotePhotoId, commentText)
  local ok, err = api(publishSettings):addComment(remotePhotoId, commentText)
  if not ok then LrDialogs.message('Could not send the reply', tostring(err), 'warning') return false end
  return true
end

return provider
