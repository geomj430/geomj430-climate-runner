"""world.png 와 meta.json 을 만드는 스크립트 (한 번만 실행하면 돼요).

원본 자료를 D 폴더에 받아 두세요.
  kp/   : npm 패키지 koppen-climate-lookup@2.0.0 (쾨펜-가이거 0.5° 격자, ISC)
  earth-topology.png, earth-water.png : github.com/vasturiano/three-globe 의 example/img (NASA 영상, MIT)
  wa/   : npm 패키지 world-atlas@2.0.2 (Natural Earth 국경, ISC)
필요한 파이썬 패키지: numpy, pillow, scipy
"""
import re, json, numpy as np
from PIL import Image
from scipy import ndimage
from PIL import ImageDraw
import sys
D=sys.argv[1] if len(sys.argv)>1 else 'sources/'
W,H=1440,720
CL="Af Am Aw As BWh BWk BSh BSk Csa Csb Csc Cwa Cwb Cwc Cfa Cfb Cfc Dsa Dsb Dsc Dsd Dwa Dwb Dwc Dwd Dfa Dfb Dfc Dfd ET EF".split()
idx={c:i+1 for i,c in enumerate(CL)}
src=open(D+'kp/package/dist/index.js').read()
csv=re.search(r'var koppen_default = "(.*?)";',src,re.S).group(1).replace('\\n','\n')
kg=np.zeros((360,720),np.uint8)
bad=set()
for line in csv.split('\n')[1:]:
    if not line: continue
    la,lo,c=line.split(',')
    la=float(la);lo=float(lo)
    y=int((90-la)/0.5);x=int((lo+180)/0.5)
    if c in idx: kg[y,x]=idx[c]
    else: bad.add(c)
print('bad',bad,'cells',(kg>0).sum())
# land mask from water png
w=Image.open(D+'earth-water.png').convert('L').resize((W,H),Image.BILINEAR)
land=(np.array(w)<128)
# add Antarctica bottom rows (water png may treat)
topo=np.array(Image.open(D+'earth-topology.png').convert('L').resize((W,H),Image.BILINEAR)).astype(np.uint8)
# koppen upsample nearest
kgu=np.repeat(np.repeat(kg,2,0),2,1)
# fill land pixels w/o class by nearest class
missing=kgu==0
dist,(iy,ix)=ndimage.distance_transform_edt(missing,return_indices=True)
kfill=kgu[iy,ix]
# land if water-mask says land; also if koppen land & topo>0
landf=land|((kgu>0)&(topo>8))
kout=np.where(landf,kfill,0).astype(np.uint8)
elev=np.where(landf,np.maximum(topo,1),0).astype(np.uint8)
print('land frac',landf.mean())
# countries
tj=json.load(open(D+'wa/package/countries-110m.json'))
sc=tj['transform']['scale'];tr=tj['transform']['translate']
arcs=[]
for a in tj['arcs']:
    x=y=0;pts=[]
    for dx,dy in a:
        x+=dx;y+=dy;pts.append((x*sc[0]+tr[0],y*sc[1]+tr[1]))
    arcs.append(pts)
def ring(r):
    out=[]
    for i in r:
        p=arcs[i] if i>=0 else arcs[~i][::-1]
        out.extend(p if not out else p[1:])
    return out
geoms=tj['objects']['countries']['geometries']
names=[g['properties']['name'] for g in geoms]
SS=4
img=Image.new('L',(W*SS,H*SS),0);dr=ImageDraw.Draw(img)
for ci,g in enumerate(geoms):
    polys=g['arcs'] if g['type']=='MultiPolygon' else [g['arcs']] if g['type']=='Polygon' else []
    for poly in polys:
        for k,r in enumerate(poly):
            pts=[((lo+180)/360*W*SS,(90-la)/180*H*SS) for lo,la in ring(r)]
            if len(pts)>2: dr.polygon(pts,fill=(ci+1) if k==0 else 0)
cty=np.array(img)[SS//2::SS,SS//2::SS]
cm=cty==0
d2,(jy,jx)=ndimage.distance_transform_edt(cm,return_indices=True)
cfill=np.where(d2<12,cty[jy,jx],0)
cout=np.where(landf,cfill,0).astype(np.uint8)
print('land w/o country',(landf&(cout==0)).sum())
rgb=np.dstack([elev,kout,cout])
Image.fromarray(rgb,'RGB').save('world.png',optimize=True)
json.dump({'classes':CL,'countries':names},open('meta.json','w'),ensure_ascii=False)
def q(la,lo):
    y=int((90-la)/180*H);x=int((lo+180)/360*W)%W
    return CL[kout[y,x]-1] if kout[y,x] else '-', elev[y,x], names[cout[y,x]-1] if cout[y,x] else '-'
for n,la,lo in [('seoul',37.57,126.98),('singapore',1.35,103.8),('cairo',30.0,31.2),('ulan',47.9,106.9),('yakutsk',62.0,129.7)]:print(n,q(la,lo))
