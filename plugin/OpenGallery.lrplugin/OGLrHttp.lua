-- LrHttp adapter for OGApi. Lightroom returns (body, headers) where headers.status is the code and headers.error a transport error.
local LrHttp = import 'LrHttp'
local M = {}
local TIMEOUT, UPLOAD_TIMEOUT = 60, 900

local function unpackResponse(body, hdrs)
  local status = hdrs and hdrs.status
  local err = hdrs and hdrs.error and (hdrs.error.name or hdrs.error.errorCode or 'transport error')
  return body, status, err
end

function M.get(url, headers) return unpackResponse(LrHttp.get(url, headers, TIMEOUT)) end
function M.post(url, body, headers) return unpackResponse(LrHttp.post(url, body, headers, 'POST', TIMEOUT)) end
function M.delete(url, headers) return unpackResponse(LrHttp.post(url, '', headers, 'DELETE', TIMEOUT)) end
function M.postMultipart(url, chunks, headers) return unpackResponse(LrHttp.postMultipart(url, chunks, headers, UPLOAD_TIMEOUT)) end

return M
