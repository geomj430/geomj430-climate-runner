#!/usr/bin/env python3
"""globe-src/ 의 파일을 모아 저장소 최상위에 globe.html(독립 실행 파일)을 만들어요.

필요: globe-src/three.min.js (three@0.159.0, npm 패키지의 build/three.min.js)
      없으면 npm 레지스트리에서 내려받아요.
"""
import base64, io, json, os, sys, tarfile, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
THREE_VER = '0.159.0'

def three_js():
    cache = os.path.join(HERE, '.cache', f'three-{THREE_VER}.min.js')
    if not os.path.exists(cache):
        os.makedirs(os.path.dirname(cache), exist_ok=True)
        url = f'https://registry.npmjs.org/three/-/three-{THREE_VER}.tgz'
        data = urllib.request.urlopen(url).read()
        with tarfile.open(fileobj=io.BytesIO(data)) as t:
            js = t.extractfile('package/build/three.min.js').read()
        open(cache, 'wb').write(js)
    return open(cache, encoding='utf-8').read()

def main():
    tpl = open(os.path.join(HERE, 'template.html'), encoding='utf-8').read()
    png = base64.b64encode(open(os.path.join(HERE, 'world.png'), 'rb').read()).decode()
    meta = json.load(open(os.path.join(HERE, 'meta.json'), encoding='utf-8'))
    data = f'const WORLD_PNG="data:image/png;base64,{png}";\nconst WORLD_META={json.dumps(meta, ensure_ascii=False)};'
    content = open(os.path.join(HERE, 'content.js'), encoding='utf-8').read()
    game = open(os.path.join(HERE, 'game.js'), encoding='utf-8').read()
    three = three_js()
    for name, body in (('THREE', three), ('DATA', data), ('CONTENT', content), ('GAME', game)):
        assert '</script' not in body.lower(), name
        tpl = tpl.replace(f'<script>/*{name}*/</script>', f'<script>\n{body}\n</script>', 1)
    out = os.path.join(ROOT, 'globe.html')
    open(out, 'w', encoding='utf-8').write(tpl)
    print(out, os.path.getsize(out) // 1024, 'KB')

if __name__ == '__main__':
    main()
