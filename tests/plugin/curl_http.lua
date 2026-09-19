-- Test-only http adapter for OGApi using curl, matching the LrHttp adapter's contract.
local M = {}
local function q(s) return "'" .. tostring(s):gsub("'", "'\\''") .. "'" end
local function run(args)
  local cmd = 'curl -sS -o - -w "\\n__STATUS__%{http_code}" ' .. args .. ' 2>&1'
  local p = assert(io.popen(cmd)); local out = p:read('*a'); p:close()
  local body, status = out:match('^(.-)\n__STATUS__(%d+)%s*$')
  if not status then return nil, nil, out end
  return body, tonumber(status), nil
end
local function hdrs(headers) local s = '' for _, h in ipairs(headers or {}) do s = s .. ' -H ' .. q(h.field .. ': ' .. h.value) end return s end
function M.get(url, headers) return run(hdrs(headers) .. ' ' .. q(url)) end
function M.post(url, body, headers) return run('-X POST --data-binary ' .. q(body) .. hdrs(headers) .. ' ' .. q(url)) end
function M.delete(url, headers) return run('-X DELETE' .. hdrs(headers) .. ' ' .. q(url)) end
function M.postMultipart(url, chunks, headers)
  local parts = ''
  for _, c in ipairs(chunks) do
    if c.filePath then parts = parts .. ' -F ' .. q(c.name .. '=@' .. c.filePath .. ';filename=' .. (c.fileName or 'file') .. ';type=' .. (c.contentType or 'application/octet-stream'))
    else parts = parts .. ' -F ' .. q(c.name .. '=' .. c.value) end
  end
  return run('-X POST' .. parts .. hdrs(headers) .. ' ' .. q(url))
end
return M
