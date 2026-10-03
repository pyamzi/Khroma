-- Library menu item: pull submitted picks for every linked collection into Lightroom flags and a "<Project> – Picks" collection.
local LrApplication = import 'LrApplication'
local LrDialogs = import 'LrDialogs'
local LrTasks = import 'LrTasks'
local LrProgressScope = import 'LrProgressScope'
local OGApi = require 'OGApi'
local OGHttp = require 'OGLrHttp'
local OGUtil = require 'OGUtil'
local json = require 'json'

local function linkedCollections(catalog)
  local out = {}
  for _, service in ipairs(catalog:getPublishServices(_PLUGIN.id)) do
    local settings = service:getPublishSettings()
    for _, coll in ipairs(service:getChildCollections()) do
      local ok, summary = pcall(function() return coll:getCollectionInfoSummary() end)
      local cs = ok and summary and summary.collectionSettings or nil
      if cs and cs.projectId and cs.projectId ~= '' then out[#out + 1] = { settings = settings, cs = cs, name = coll:getName() } end
    end
  end
  return out
end

LrTasks.startAsyncTask(function()
  local catalog = LrApplication.activeCatalog()
  local links = linkedCollections(catalog)
  if #links == 0 then LrDialogs.message('No Kreate collections', 'Create a publish collection linked to a project first.', 'info') return end
  local progress = LrProgressScope { title = 'Syncing picks from Kreate' }
  local report = {}
  for i, link in ipairs(links) do
    progress:setPortionComplete(i - 1, #links)
    local a = OGApi.new{ baseUrl = OGUtil.trim(link.settings.serverUrl), token = OGUtil.trim(link.settings.token), http = OGHttp }
    local picks, err = a:picks(link.cs.projectId)
    if not picks then report[#report + 1] = link.name .. ': ' .. tostring(err)
    elseif #picks.picks == 0 then report[#report + 1] = link.name .. ': no submitted picks yet'
    else
      local photos, unresolved, wanted = {}, {}, {}
      for _, p in ipairs(picks.picks) do
        local path = OGUtil.catalogPath(link.settings.mountPath, link.cs.folderPath, p.relPath)
        local photo = catalog:findPhotoByPath(path)
        if photo then photos[#photos + 1] = { photo = photo, id = p.photoId }; wanted[p.photoId] = true else unresolved[#unresolved + 1] = p.relPath end
      end
      local key = 'flagged:' .. link.cs.projectId
      local previous = {}
      pcall(function() previous = json.decode(catalog:getPropertyForPlugin(_PLUGIN, key) or '[]') end)
      catalog:withWriteAccessDo('Kreate picks', function()
        local set = catalog:createCollectionSet('Kreate', nil, true)
        local coll = catalog:createCollection((link.cs.projectTitle or link.name) .. ' – Picks', set, true)
        local lrPhotos, flaggedNow = {}, {}
        for _, e in ipairs(photos) do
          e.photo:setRawMetadata('pickStatus', 1)
          e.photo:setPropertyForPlugin(_PLUGIN, 'ogSourceId', e.id)
          e.photo:setPropertyForPlugin(_PLUGIN, 'ogProjectId', link.cs.projectId)
          e.photo:setPropertyForPlugin(_PLUGIN, 'ogSubmittedAt', picks.submittedAt or '')
          lrPhotos[#lrPhotos + 1] = e.photo; flaggedNow[#flaggedNow + 1] = e.photo:getRawMetadata('uuid')
        end
        if #lrPhotos > 0 then coll:addPhotos(lrPhotos) end
        -- clear flags we set earlier for photos the client un-picked before finishing (only if still flagged)
        local nowSet = {}
        for _, u in ipairs(flaggedNow) do nowSet[u] = true end
        for _, uuid in ipairs(previous) do
          if not nowSet[uuid] then local ph = catalog:findPhotoByUuid(uuid); if ph and ph:getRawMetadata('pickStatus') == 1 then ph:setRawMetadata('pickStatus', 0) end end
        end
        catalog:setPropertyForPlugin(_PLUGIN, key, json.encode(flaggedNow))
      end)
      report[#report + 1] = string.format('%s: %d picks flagged (round %d)%s', link.name, #photos, tonumber(picks.round) or 0, #unresolved > 0 and (', ' .. #unresolved .. ' not found under the mount path') or '')
      for _, u in ipairs(unresolved) do report[#report + 1] = '   missing: ' .. u end
    end
  end
  progress:done()
  LrDialogs.message('Kreate picks', table.concat(report, '\n'), 'info')
end)
