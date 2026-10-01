#!/bin/zsh
# Sets a Fly secret from the clipboard, repairing common copy/paste damage. Prints only a redacted shape.
#   zsh scripts/fly-secret-from-clipboard.zsh db       # after clicking copy on Neon's connection string
#   zsh scripts/fly-secret-from-clipboard.zsh resend   # after copying a Resend API key (re_...)
set -e
setopt extendedglob
APP=opengallery
v=$(pbpaste)
v=${v//[[:space:]]/}; v=${v//\'/}; v=${v//\"/}

case $1 in
  db)
    v=${v#psql}; v=${v#DATABASE_URL=}
    # Neon's copy can drop the head, leaving "password@host/db?..."
    [[ $v != postgres* && $v == *@*neon.tech/* ]] && v="postgresql://neondb_owner:$v"
    v=${v//&channel_binding=require/}; v=${v//channel_binding=require&/}; v=${v//\?channel_binding=require/}
    if [[ $v != *sslmode=require* ]]; then [[ $v == *\?* ]] && v+='&sslmode=require' || v+='?sslmode=require'; fi
    if [[ $v != postgres(ql|)://*:*@*.neon.tech/* ]]; then echo "Clipboard isn't a Neon connection string. Nothing changed."; exit 1; fi
    echo "Setting DATABASE_URL: ${v[1,13]}… (${#v} chars, host ${${v#*@}%%/*})"
    fly secrets set -a $APP --stage "DATABASE_URL=$v" ;;
  resend)
    v=${v#RESEND_API_KEY=}
    if [[ $v != re_[A-Za-z0-9_]## ]]; then echo "Clipboard isn't a Resend API key (re_...). Nothing changed."; exit 1; fi
    echo "Setting RESEND_API_KEY: re_… (${#v} chars) and removing SMTP_URL"
    fly secrets set -a $APP --stage "RESEND_API_KEY=$v"
    fly secrets unset -a $APP --stage SMTP_URL 2>/dev/null || true ;;
  *) echo "usage: zsh $0 db|resend"; exit 2 ;;
esac
echo "Staged. Tell Claude to deploy."
