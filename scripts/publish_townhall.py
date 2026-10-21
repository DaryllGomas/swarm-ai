#!/usr/bin/env python3
"""Prepare a Town Hall solution from accepted Swarm research. Standard library only; no push."""
import datetime
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    # Never forward the bearer token to a redirected host.
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def git(repo, *args):
    return subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True, text=True).stdout.strip()


def solution(s):
    """Map the four Swarm headings onto Town Hall's six sections; never invent the missing analysis."""
    source = re.fullmatch(r'townhall:([a-z0-9]+(?:-[a-z0-9]+)*):fix', s['source_key'] or '')
    if not source:
        raise ValueError('Not a Town Hall research task with a valid problem slug.')
    problem = source[1]
    body = s['body'].strip()
    sections = {}
    heading = None
    preamble = []
    patterns = {
        'goal': 'Summary', 'summary': 'Summary', 'steps': 'How it works', 'how it works': 'How it works',
        'who can make it happen': 'Who can make it happen', 'sources': 'Sources',
        'who it helps and what it costs': 'Who it helps and what it costs', 'trade-offs and risks': 'Trade-offs and risks',
    }
    for line in body.splitlines():
        match = re.match(r'^(?:#{1,3}\s*)?(Goal|Summary|Steps|How it works|Who can make it happen|Sources|Who it helps and what it costs|Trade-offs and risks)(?:\s*:\s*(.*)|\s*)$', line, re.I)
        if match:
            heading = patterns[match[1].lower()]
            sections.setdefault(heading, []).append(match[2] or '')
        elif heading:
            sections[heading].append(line)
        else:
            preamble.append(line)
    if not all(''.join(sections.get(k, [])).strip() for k in ['Summary', 'How it works', 'Who can make it happen']):
        # Preserve all accepted content if it doesn't have parseable headings. Do not guess at what it means.
        sections = {'Summary': [body]}
    elif ''.join(preamble).strip():
        sections['Summary'] = preamble + [''] + sections['Summary']
    sources = s['sources']
    if not isinstance(sources, list) or not sources or any(not isinstance(u, str) or not u.startswith('https://') for u in sources):
        raise ValueError('Town Hall requires https sources. Review this receipt manually.')
    if not sections.get('Sources') or not ''.join(sections['Sources']).strip():
        sections['Sources'] = ['\n'.join('- ' + u for u in sources)]
    title = re.sub(r'^Research a fix for:\s*', '', s['title'])
    title = f"Swarm research {s['id']}: {title}"[:116]
    # Public-safe projection: the self-reported model name and token figures are private to the contributor and the reviewer (a distinctive
    # model string can fingerprint a contributor), so they never reach a public repository. Even if the receipt carried a model, it is ignored
    # here. The credit label is the one the contributor chose: their handle only for handle credit, else the generic label.
    handle = s.get('handle')
    credit = handle if isinstance(handle, str) and re.fullmatch(r'[a-z0-9_-]{3,24}', handle) else ('removed contributor' if s.get('credited_as') == 'removed contributor' else 'a contributor')
    scale = os.environ.get('TOWNHALL_SCALE', '')
    if scale not in {'individual', 'community', 'business', 'state', 'federal'}:
        raise ValueError('Set TOWNHALL_SCALE to individual, community, business, state or federal after reviewing the submission.')
    front = {
        'title': json.dumps(title, ensure_ascii=False), 'problem': problem, 'type': 'idea', 'status': 'proposed',
        'scale': scale, 'submitted_by': credit, 'written_with': 'ai-agent',
        'date': datetime.date.today().isoformat(),
    }
    text = '---\n' + '\n'.join(f'{k}: {v}' for k, v in front.items()) + '\n---\n\n# ' + title + '\n\n'
    text += f"Prepared from accepted Swarm submission #{s['id']}. Written by an AI. This research is a proposed idea; the operator must verify the analysis before opening the PR.\n\n"
    for name in ['Summary', 'How it works', 'Who can make it happen', 'Who it helps and what it costs', 'Trade-offs and risks', 'Sources']:
        content = '\n'.join(sections.get(name, [])).strip() or 'Not assessed in the accepted submission. Operator review required before publication.'
        text += f'## {name}\n\n{content}\n\n'
    return problem, text


def prepare(repo, s):
    repo = repo.expanduser().resolve(strict=True)
    if git(repo, 'status', '--porcelain'):
        raise ValueError('Town Hall checkout must be clean before preparing a publication.')
    email = git(repo, 'config', 'user.email')
    if not re.fullmatch(r'\d+\+[^@\s]+@users\.noreply\.github\.com', email):
        raise ValueError('Configure the owner GitHub noreply identity in Town Hall before committing.')
    problem, text = solution(s)
    directory = (repo / 'problems' / problem / 'solutions').resolve(strict=True)
    if not directory.is_relative_to(repo / 'problems') or not (repo / 'problems' / problem / 'README.md').is_file():
        raise ValueError('Problem folder must already exist inside Town Hall.')
    target = directory / f"swarm-research-{s['id']}.md"
    if target.exists():
        raise ValueError('This submission already has a solution file. Nothing changed.')
    branch = f"swarm/submission-{s['id']}"
    original = git(repo, 'symbolic-ref', '--short', 'HEAD')
    git(repo, 'switch', '-c', branch)
    try:
        # Never overwrite a tracked/untracked file, even if another publisher races this one.
        with target.open('x', encoding='utf-8') as out:
            out.write(text)
        relative = str(target.relative_to(repo))
        checker = repo / 'scripts' / 'check_submission.py'
        if not checker.is_file():
            raise ValueError('Town Hall submission checker is missing.')
        subprocess.run(['python3', str(checker), '--repo', str(repo), '--files', str(target)], check=True)
        git(repo, 'add', '--', relative)
        message = f"Add research from Swarm submission {s['id']}\n\nAI-written research, accepted by the Swarm reviewer.\n\nCo-Authored-By: OpenAI Codex <noreply@openai.com>"
        git(repo, 'commit', '-m', message)
    except Exception:
        # Leave the draft/branch for inspection and repair; never reset or delete the operator's work.
        print(f'Preparation stopped on {branch}. Inspect the draft before retrying.', file=sys.stderr)
        raise
    command = ['gh', 'pr', 'create', '--base', original, '--head', branch, '--title', f"Town Hall research from Swarm #{s['id']}",
               '--body', f"AI-written research from accepted Swarm submission #{s['id']}. Review sources, the selected scale and any unassessed sections before merging."]
    print(f'Committed {relative} on {branch}. Nothing pushed.')
    print('Review the draft and complete any unassessed sections, then push the branch yourself.')
    print('From the Town Hall checkout, run: ' + shlex.join(command))
    return target


def main():
    if len(sys.argv) != 2 or not re.fullmatch(r'[1-9]\d{0,8}', sys.argv[1]):
        raise ValueError('usage: scripts/publish-townhall.sh <submission_id>')
    base = os.environ.get('SWARM_URL', 'https://swarm.bigpicsolutions.com').rstrip('/')
    # Local HTTP is allowed only for an explicitly selected loopback development server.
    if not re.fullmatch(r'https://[^/?#@\s]+|http://(?:localhost|127\.0\.0\.1)(?::\d+)?', base):
        raise ValueError('SWARM_URL must be an https origin (or local loopback HTTP).')
    token_path = Path(os.environ.get('SWARM_ADMIN_TOKEN_FILE', '~/.config/swarm-ai/admin-token')).expanduser()
    token = token_path.read_text().strip()
    req = urllib.request.Request(base + '/api/admin/submission?id=' + sys.argv[1], headers={'Authorization': 'Bearer ' + token})
    with urllib.request.build_opener(NoRedirect).open(req, timeout=20) as response:
        data = response.read(65537)
    if len(data) > 65536:
        raise ValueError('Receipt response is too large.')
    s = json.loads(data)['submission']
    if s['id'] != int(sys.argv[1]):
        raise ValueError('Receipt ID did not match.')
    if s.get('published_url'):
        raise ValueError('This receipt is already published.')
    prepare(Path(os.environ.get('TOWNHALL_REPO', '~/Projects/tools/town-hall')), s)


if __name__ == '__main__':
    try:
        main()
    except Exception as err:
        # Do not print HTTP request headers or raw responses, which could contain secrets.
        detail = str(err) if isinstance(err, ValueError) else type(err).__name__
        print(f'Publication preparation failed: {detail}. No push was attempted.', file=sys.stderr)
        sys.exit(1)
