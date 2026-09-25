#!/usr/bin/env python3
"""Build claude_proxy.js config from the agy profile.

Writes (mode 600, outside the repo — the MCP config carries private URLs/tokens):
  ~/.config/openclaw-claude/mcp.json       Claude Code --mcp-config (from agy mcp_config.json)
  ~/.config/openclaw-claude/ro-allow.json  RO allowlist (from the agy RO profile settings.json)
  ~/.config/openclaw-claude/projects.json  project contexts — created empty once, never overwritten

Rule mapping agy -> Claude Code:
  mcp(server/tool)  -> mcp__server__tool
  read_file(/path)  -> Read(//path)   (leading // = absolute path in Claude Code rules)
Anything else is reported and skipped.
"""
import json
import os
import re
import sys

HOME = os.path.expanduser('~')
AGY_MCP = os.environ.get('AGY_MCP_CONFIG', f'{HOME}/.gemini/antigravity-cli/mcp_config.json')
AGY_RO = os.environ.get('AGY_RO_SETTINGS', f'{HOME}/.agy-profiles/ro/.gemini/antigravity-cli/settings.json')
OUT = os.environ.get('CC_CONFIG_DIR', f'{HOME}/.config/openclaw-claude')


def convert_server(name, srv):
    if 'url' in srv or 'serverUrl' in srv or 'httpUrl' in srv:
        url = srv.get('url') or srv.get('serverUrl') or srv.get('httpUrl')
        out = {'type': 'sse' if url.rstrip('/').endswith('/sse') else 'http', 'url': url}
        if srv.get('headers'):
            out['headers'] = srv['headers']
        return out
    if 'command' in srv:
        out = {'type': 'stdio', 'command': srv['command'], 'args': srv.get('args', [])}
        if srv.get('env'):
            out['env'] = srv['env']
        return out
    print(f'  ! pominięto serwer {name}: nieznany format {sorted(srv)}', file=sys.stderr)
    return None


def convert_rule(rule):
    m = re.fullmatch(r'mcp\(([^/]+)/([^)]+)\)', rule)
    if m:
        return f'mcp__{m.group(1)}__{m.group(2)}'
    m = re.fullmatch(r'read_file\((/[^)]+)\)', rule)
    if m:
        return f'Read(/{m.group(1)})'
    return None


def write_private(path, obj):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
        f.write('\n')
    os.chmod(path, 0o600)


def main():
    os.makedirs(OUT, exist_ok=True)
    servers = json.load(open(AGY_MCP)).get('mcpServers', {})
    mcp = {}
    for name, srv in servers.items():
        c = convert_server(name, srv)
        if c:
            mcp[name] = c
    # Claude-only bridge to OpenClaw subagents (see mcp/openclaw-agents.js).
    # Not in the RO allowlist on purpose: ha-yaml can write.
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    mcp['openclaw_agents'] = {'type': 'stdio', 'command': 'node', 'args': [os.path.join(repo, 'mcp', 'openclaw-agents.js')]}
    write_private(f'{OUT}/mcp.json', {'mcpServers': mcp})
    print(f'mcp.json: {len(mcp)} serwerów ({", ".join(mcp)})')

    allow, skipped = [], []
    if os.path.exists(AGY_RO):
        for rule in json.load(open(AGY_RO)).get('permissions', {}).get('allow', []):
            c = convert_rule(rule)
            (allow.append(c) if c else skipped.append(rule))
    write_private(f'{OUT}/ro-allow.json', {'allow': allow})
    print(f'ro-allow.json: {len(allow)} reguł')
    for r in skipped:
        print(f'  ! pominięto regułę agy bez odpowiednika: {r}', file=sys.stderr)

    projects = f'{OUT}/projects.json'
    if not os.path.exists(projects):
        write_private(projects, {})
        print('projects.json: utworzono pusty (dodaj np. {"ha": {"dir": "/ścieżka", "roDeny": []}})')


if __name__ == '__main__':
    main()
