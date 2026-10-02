-- Library menu item: report which submitted RAWs have been edited since the client finished picking.
local LrApplication = import 'LrApplication'
local LrDialogs = import 'LrDialogs'
local LrTasks = import 'LrTasks'
local OGApi = require 'OGApi'
local OGHttp = require 'OGLrHttp'
local OGUtil = require 'OGUtil'

LrTasks.startAsyncTask(function()
  local catalog = LrApplication.activeCatalog()
  local byProject = {}
  for _, photo in ipairs(catalog:findPhotosWithProperty(_PLUGIN, 'ogSourceId')) do
    local pid = photo:getPropertyForPlugin(_PLUGIN, 'ogProjectId', nil, true)
    if pid and pid ~= '' then byProject[pid] = byProject[pid] or {}; table.insert(byProject[pid], photo) end
  end
  local services = catalog:getPublishServices(_PLUGIN.id)
  if #services == 0 then LrDialogs.message('No Kreate publish service', 'Set one up in the Publish Services panel first.', 'info') return end
  local settings = services[1]:getPublishSettings()
  local a = OGApi.new{ baseUrl = OGUtil.trim(settings.serverUrl), token = OGUtil.trim(settings.token), http = OGHttp }
  local lines = {}
  for pid, photos in pairs(byProject) do
    local reports = {}
    for _, photo in ipairs(photos) do
      local submitted = OGUtil.isoToLrTime(photo:getPropertyForPlugin(_PLUGIN, 'ogSubmittedAt', nil, true))
      local edited = photo:getRawMetadata('lastEditTime') or 0
      reports[#reports + 1] = { photoId = photo:getPropertyForPlugin(_PLUGIN, 'ogSourceId', nil, true), state = (submitted and edited > submitted) and 'editing' or 'none' }
    end
    local r, err = a:progress(pid, reports)
    lines[#lines + 1] = r and string.format('%s: %d updated, %d unchanged', pid:sub(1, 8), r.updated, r.skipped) or (pid:sub(1, 8) .. ': ' .. tostring(err))
  end
  if #lines == 0 then lines[1] = 'No synced picks yet. Run "Sync picks" first.' end
  LrDialogs.message('Kreate editing progress', table.concat(lines, '\n'), 'info')
end)
