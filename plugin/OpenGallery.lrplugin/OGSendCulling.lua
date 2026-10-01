-- Library menu item: send each selected photo's 2048 px JPEG preview to a project as a culling photo.
-- The RAW never leaves this machine; re-sending an unchanged preview is a no-op on the server.
local LrApplication = import 'LrApplication'
local LrBinding = import 'LrBinding'
local LrDialogs = import 'LrDialogs'
local LrFileUtils = import 'LrFileUtils'
local LrFunctionContext = import 'LrFunctionContext'
local LrPathUtils = import 'LrPathUtils'
local LrProgressScope = import 'LrProgressScope'
local LrTasks = import 'LrTasks'
local LrView = import 'LrView'
local OGApi = require 'OGApi'
local OGHttp = require 'OGLrHttp'
local OGUtil = require 'OGUtil'

-- Returns the chosen project id, or nil when the user cancels.
local function chooseProject(projects)
  return LrFunctionContext.callWithContext('OGSendCulling', function(context)
    local props = LrBinding.makePropertyTable(context)
    props.project = projects[1].id
    local items = {}
    for _, p in ipairs(projects) do items[#items + 1] = { title = p.title .. '  ·  ' .. tostring(p.client), value = p.id } end
    local f = LrView.osFactory()
    local result = LrDialogs.presentModalDialog {
      title = 'Send for culling to OpenGallery',
      actionVerb = 'Send',
      contents = f:column { bind_to_object = props, spacing = f:control_spacing(),
        f:static_text { title = 'Project', font = '<system/bold>' },
        f:popup_menu { value = LrView.bind 'project', items = items, width_in_chars = 40 },
      },
    }
    if result == 'ok' then return props.project end
  end)
end

-- Renders the photo's 2048 px JPEG preview to a temp file. Returns its path, or nil plus a reason.
local function renderPreview(photo)
  local done, jpeg, reason = false, nil, nil
  local request = photo:requestJpegThumbnail(2048, 2048, function(data, err) jpeg, reason, done = data, err, true end) -- keep `request` referenced until the callback fires
  while not done do LrTasks.sleep(0.05) end
  request = nil
  if not jpeg then return nil, reason or 'no preview available' end
  local path = LrPathUtils.child(LrPathUtils.getStandardFilePath('temp'), 'og-culling-' .. tostring(os.time()) .. '-' .. tostring(math.random(1e6)) .. '.jpg')
  local fh = io.open(path, 'wb')
  if not fh then return nil, 'could not write ' .. path end
  fh:write(jpeg); fh:close()
  return path
end

LrTasks.startAsyncTask(function()
  local catalog = LrApplication.activeCatalog()
  local photos = catalog:getTargetPhotos()
  if #photos == 0 then LrDialogs.message('No photos selected', 'Select the photos to send for culling.', 'info') return end
  local services = catalog:getPublishServices(_PLUGIN.id)
  if #services == 0 then LrDialogs.message('No OpenGallery publish service', 'Set one up in the Publish Services panel first.', 'info') return end
  local settings = services[1]:getPublishSettings()
  local a = OGApi.new{ baseUrl = OGUtil.trim(settings.serverUrl), token = OGUtil.trim(settings.token), http = OGHttp }
  local projects, perr = a:projects()
  if not projects then LrDialogs.message('Could not reach OpenGallery', tostring(perr), 'critical') return end
  if #projects == 0 then LrDialogs.message('No projects', 'Create a project in OpenGallery first.', 'info') return end
  local projectId = chooseProject(projects)
  if not projectId then return end

  local progress = LrProgressScope { title = 'Sending previews to OpenGallery' }
  local sent, unchanged, failed, firstError = 0, 0, 0, nil
  -- Previews are keyed by RAW file name (raw/<name>), so two selected photos with one name (second shooter, counter rollover,
  -- virtual copies) would overwrite each other: refuse them. ponytail: a clash with a photo sent in an EARLIER batch is not detected;
  -- a source-identity check on the server is planned.
  local names = {}
  for i, photo in ipairs(photos) do names[i] = LrPathUtils.leafName(photo:getRawMetadata('path')) end
  local dups = OGUtil.duplicateLeaves(names)
  local dupLines = {}
  for n, c in pairs(dups) do dupLines[#dupLines + 1] = string.format('%s appears %d times in this selection (different folders or virtual copies). Send them separately after renaming.', n, c) end
  table.sort(dupLines)
  for i, photo in ipairs(photos) do
    if progress:isCanceled() then break end
    progress:setPortionComplete(i - 1, #photos)
    local name = names[i]
    progress:setCaption(name)
    local file, why
    if dups[name] then why = 'duplicate file name in this selection' else file, why = renderPreview(photo) end
    local r, err
    if file then
      r, err = a:uploadCulling(projectId, { filePath = file, relPath = 'raw/' .. name })
      LrFileUtils.delete(file)
    else err = why end
    if not r then failed = failed + 1; if not dups[name] then firstError = firstError or (name .. ': ' .. tostring(err)) end
    elseif r.created or r.replaced then sent = sent + 1
    else unchanged = unchanged + 1 end
  end
  progress:done()
  local summary = string.format('%d sent, %d unchanged, %d failed.', sent, unchanged, failed)
  if #dupLines > 0 then summary = summary .. '\n\n' .. table.concat(dupLines, '\n') end
  if firstError then summary = summary .. '\nFirst error: ' .. firstError end
  LrDialogs.message('OpenGallery culling', summary, failed > 0 and 'warning' or 'info')
end)
