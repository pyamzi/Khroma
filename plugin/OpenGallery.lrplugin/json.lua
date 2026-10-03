-- Minimal JSON for Lightroom's Lua 5.1: objects, arrays, strings, numbers, booleans, null.
-- Decoded null becomes json.null; encode treats json.null as null.
local json = {}
json.null = setmetatable({}, { __tostring = function() return 'null' end })

local escapes = { ['"'] = '\\"', ['\\'] = '\\\\', ['\b'] = '\\b', ['\f'] = '\\f', ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t' }
local function encodeString(s)
  return '"' .. s:gsub('[%c"\\]', function(c) return escapes[c] or string.format('\\u%04x', c:byte()) end) .. '"'
end

local function isArray(t)
  local n = 0
  for k in pairs(t) do
    if type(k) ~= 'number' or k <= 0 or math.floor(k) ~= k then return false end
    if k > n then n = k end
  end
  return n == #t
end

function json.encode(v)
  local t = type(v)
  if v == json.null or v == nil then return 'null' end
  if t == 'boolean' then return v and 'true' or 'false' end
  if t == 'number' then
    if v ~= v or v == math.huge or v == -math.huge then error('cannot encode ' .. tostring(v)) end
    if math.floor(v) == v and math.abs(v) < 1e15 then return string.format('%d', v) end
    return string.format('%.14g', v)
  end
  if t == 'string' then return encodeString(v) end
  if t == 'table' then
    local out = {}
    if isArray(v) then
      for i = 1, #v do out[i] = json.encode(v[i]) end
      return '[' .. table.concat(out, ',') .. ']'
    end
    local keys = {}
    for k in pairs(v) do keys[#keys + 1] = tostring(k) end
    table.sort(keys)
    for i, k in ipairs(keys) do out[i] = encodeString(k) .. ':' .. json.encode(v[k]) end
    return '{' .. table.concat(out, ',') .. '}'
  end
  error('cannot encode ' .. t)
end

-- decoder
local function skip(s, i)
  local _, e = s:find('^[ \t\r\n]*', i)
  return e + 1
end
local decodeValue

local function decodeString(s, i)
  local out, j = {}, i + 1
  while true do
    local c = s:sub(j, j)
    if c == '' then error('unterminated string at ' .. i) end
    if c == '"' then return table.concat(out), j + 1 end
    if c == '\\' then
      local n = s:sub(j + 1, j + 1)
      local map = { b = '\b', f = '\f', n = '\n', r = '\r', t = '\t', ['"'] = '"', ['\\'] = '\\', ['/'] = '/' }
      if n == 'u' then
        local hex = s:sub(j + 2, j + 5); local code = tonumber(hex, 16)
        if not code then error('bad unicode escape at ' .. j) end
        j = j + 6
        if code >= 0xD800 and code <= 0xDBFF and s:sub(j, j + 1) == '\\u' then
          local low = tonumber(s:sub(j + 2, j + 5), 16)
          if low and low >= 0xDC00 and low <= 0xDFFF then code = 0x10000 + (code - 0xD800) * 0x400 + (low - 0xDC00); j = j + 6 end
        end
        if code < 0x80 then out[#out + 1] = string.char(code)
        elseif code < 0x800 then out[#out + 1] = string.char(0xC0 + math.floor(code / 0x40), 0x80 + code % 0x40)
        elseif code < 0x10000 then out[#out + 1] = string.char(0xE0 + math.floor(code / 0x1000), 0x80 + math.floor(code / 0x40) % 0x40, 0x80 + code % 0x40)
        else out[#out + 1] = string.char(0xF0 + math.floor(code / 0x40000), 0x80 + math.floor(code / 0x1000) % 0x40, 0x80 + math.floor(code / 0x40) % 0x40, 0x80 + code % 0x40) end
      else
        if not map[n] then error('bad escape \\' .. n .. ' at ' .. j) end
        out[#out + 1] = map[n]; j = j + 2
      end
    else
      local stop = s:find('["\\]', j) or (#s + 1)
      out[#out + 1] = s:sub(j, stop - 1); j = stop
    end
  end
end

function decodeValue(s, i)
  i = skip(s, i)
  local c = s:sub(i, i)
  if c == '{' then
    local obj = {}; i = skip(s, i + 1)
    if s:sub(i, i) == '}' then return obj, i + 1 end
    while true do
      local k; k, i = decodeString(s, skip(s, i)); i = skip(s, i)
      if s:sub(i, i) ~= ':' then error('expected : at ' .. i) end
      local v; v, i = decodeValue(s, i + 1); obj[k] = v; i = skip(s, i)
      local d = s:sub(i, i)
      if d == '}' then return obj, i + 1 end
      if d ~= ',' then error('expected , or } at ' .. i) end
      i = i + 1
    end
  elseif c == '[' then
    local arr = {}; i = skip(s, i + 1)
    if s:sub(i, i) == ']' then return arr, i + 1 end
    while true do
      local v; v, i = decodeValue(s, i); arr[#arr + 1] = v; i = skip(s, i)
      local d = s:sub(i, i)
      if d == ']' then return arr, i + 1 end
      if d ~= ',' then error('expected , or ] at ' .. i) end
      i = i + 1
    end
  elseif c == '"' then return decodeString(s, i)
  elseif s:sub(i, i + 3) == 'true' then return true, i + 4
  elseif s:sub(i, i + 4) == 'false' then return false, i + 5
  elseif s:sub(i, i + 3) == 'null' then return json.null, i + 4
  else
    local num = s:match('^-?%d+%.?%d*[eE]?[-+]?%d*', i)
    if not num or num == '' then error('unexpected character at ' .. i .. ': ' .. c) end
    return tonumber(num), i + #num
  end
end

function json.decode(s)
  if type(s) ~= 'string' then error('json.decode expects a string') end
  local v, i = decodeValue(s, 1)
  i = skip(s, i)
  if i <= #s then error('trailing garbage at ' .. i) end
  return v
end

return json
