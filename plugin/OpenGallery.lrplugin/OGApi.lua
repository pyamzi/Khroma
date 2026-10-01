-- OpenGallery API client. Pure Lua 5.1: no Lightroom imports, so it runs under a plain interpreter for tests.
-- http adapter contract: get(url, headers) / post(url, body, headers) / delete(url, headers) / postMultipart(url, chunks, headers)
-- each returning body (string or nil), status (number or nil), err (string or nil). Headers are { { field = ..., value = ... } }.
local json = require 'json'

local OGApi = {}
OGApi.__index = OGApi

function OGApi.new(opts)
  assert(opts and opts.http, 'OGApi.new needs an http adapter')
  local self = setmetatable({}, OGApi)
  self.baseUrl = (opts.baseUrl or ''):gsub('/+$', '')
  self.token = opts.token or ''
  self.http = opts.http
  return self
end

function OGApi:headers(extra)
  local h = { { field = 'Authorization', value = 'Bearer ' .. self.token }, { field = 'Accept', value = 'application/json' } }
  for _, e in ipairs(extra or {}) do h[#h + 1] = e end
  return h
end

local function decodeBody(body)
  if not body or body == '' then return nil end
  local ok, v = pcall(json.decode, body)
  if ok then return v end
  return nil
end

-- Returns decoded JSON, or nil plus a readable error. Never throws on transport errors.
function OGApi:request(method, path, body, chunks)
  local url = self.baseUrl .. path
  local raw, status, err
  if method == 'GET' then raw, status, err = self.http.get(url, self:headers())
  elseif method == 'DELETE' then raw, status, err = self.http.delete(url, self:headers())
  elseif chunks then raw, status, err = self.http.postMultipart(url, chunks, self:headers())
  else raw, status, err = self.http.post(url, json.encode(body or {}), self:headers({ { field = 'Content-Type', value = 'application/json' } })) end
  if not status or status == 0 then return nil, 'No response from ' .. self.baseUrl .. (err and (' (' .. tostring(err) .. ')') or '') end -- LrHttp gives nil, curl gives 0
  local decoded = decodeBody(raw)
  if status >= 400 then
    local msg = (type(decoded) == 'table' and decoded.error) or tostring(raw or '')
    if status == 401 then msg = 'token rejected (' .. tostring(msg) .. ')' end
    return nil, 'HTTP ' .. status .. ': ' .. tostring(msg)
  end
  if decoded == nil then return nil, 'HTTP ' .. status .. ': unreadable response' end
  return decoded
end

function OGApi:me() return self:request('GET', '/api/plugin/me') end
function OGApi:projects() return self:request('GET', '/api/plugin/projects') end
function OGApi:clients() return self:request('GET', '/api/plugin/clients') end
function OGApi:createProject(clientId, title) return self:request('POST', '/api/plugin/projects', { clientId = clientId, title = title }) end

-- paths: array of project-relative paths. Returns { [path] = photoId or false }.
function OGApi:resolve(projectId, paths)
  local r, err = self:request('POST', '/api/plugin/projects/' .. projectId .. '/resolve', { paths = paths })
  if not r then return nil, err end
  local out = {}
  for p, id in pairs(r.paths or {}) do out[p] = (id ~= json.null) and id or false end
  return out
end

-- opts: filePath, name, sourcePhotoId (optional), uploadId, checksum (optional)
function OGApi:uploadFinal(projectId, opts)
  assert(opts.filePath and opts.name and opts.uploadId, 'uploadFinal needs filePath, name, uploadId')
  local chunks = {
    { name = 'name', value = opts.name },
    { name = 'uploadId', value = opts.uploadId },
  }
  if opts.sourcePhotoId then chunks[#chunks + 1] = { name = 'sourcePhotoId', value = opts.sourcePhotoId } end
  if opts.checksum then chunks[#chunks + 1] = { name = 'checksum', value = opts.checksum } end
  chunks[#chunks + 1] = { name = 'file', fileName = opts.name, filePath = opts.filePath, contentType = 'image/jpeg' }
  return self:request('POST', '/api/plugin/projects/' .. projectId .. '/finals', nil, chunks)
end

-- Sends a RAW's rendered JPEG preview as a culling photo. opts: filePath, relPath ('raw/<RAW file name>').
-- Returns { photoId, created, replaced }; re-sending identical bytes is a no-op (created and replaced both false).
function OGApi:uploadCulling(projectId, opts)
  assert(opts.filePath and opts.relPath, 'uploadCulling needs filePath, relPath')
  local chunks = {
    { name = 'relPath', value = opts.relPath },
    { name = 'file', fileName = 'preview.jpg', filePath = opts.filePath, contentType = 'image/jpeg' },
  }
  return self:request('POST', '/api/plugin/projects/' .. projectId .. '/culling', nil, chunks)
end

function OGApi:deleteFinal(photoId) return self:request('DELETE', '/api/plugin/finals/' .. photoId) end
function OGApi:picks(projectId) return self:request('GET', '/api/plugin/projects/' .. projectId .. '/picks') end
function OGApi:comments(projectId, since)
  local q = since and ('?since=' .. since:gsub('[^%w%-:%.TZ]', '')) or ''
  return self:request('GET', '/api/plugin/projects/' .. projectId .. '/comments' .. q)
end
function OGApi:addComment(photoId, text) return self:request('POST', '/api/plugin/photos/' .. photoId .. '/comments', { text = text }) end
-- reports: array of { photoId = ..., state = 'editing' | 'none' }
function OGApi:progress(projectId, reports) return self:request('POST', '/api/plugin/projects/' .. projectId .. '/progress', { reports = reports }) end

return OGApi
