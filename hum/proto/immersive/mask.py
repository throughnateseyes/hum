import numpy as np, sys
from PIL import Image
from scipy import ndimage as nd
from multiprocessing import Pool
import os
os.makedirs('brm',exist_ok=True)
H=900;W=1600
yy,xx=np.mgrid[0:H,0:W]
def one(i):
    im=np.asarray(Image.open(f'br/{i:04d}.jpg').convert('RGB')).astype(np.float32)/255
    L=im@np.array([.3,.59,.11],np.float32)
    # local background: the brightest smooth surround (sky) beats thin dark things
    loc=nd.uniform_filter1d(nd.maximum_filter1d(L,71,axis=1),41,axis=1)
    thin=nd.gaussian_filter(L,.7) < loc*0.70-0.0
    dark=L<0.30
    sat=im.max(2)-im.min(2)
    cloud=(xx>W*.62)&(yy>H*.22)&(yy<H*.68)
    v0=(L<nd.gaussian_filter1d(L,11,axis=1)-.03)
    vert=nd.binary_opening(v0,np.ones((15,1)))
    lab0,n0=nd.label(vert,np.ones((3,3)))
    if n0:
        ob=nd.find_objects(lab0); tall=np.zeros(n0+1,bool)
        for j,o in enumerate(ob): tall[j+1]=(o[0].stop-o[0].start)>130
        vert=tall[lab0]
    # structure: thin dark, or grey-dark mass
    st=(thin&~cloud)|(dark&~cloud)|(cloud&vert)
    grey=(L<.46)&(sat<.11)&~cloud&((yy<H*.6)|(L<.36))
    grey0=nd.uniform_filter(L,25)<.47
    st|=grey
    # solid things are tall: keep clouds out by dropping blobs that touch nothing
    sky=~st
    sky&=yy<H*.755
    # tidy
    sky=nd.binary_opening(sky,iterations=1)
    lab,n=nd.label(~sky); 
    sz=np.bincount(lab.ravel()); small=sz<160; small[0]=False
    sky|=small[lab]
    lab,n=nd.label(sky); sz=np.bincount(lab.ravel()); sm2=sz<420; sm2[0]=False; sky&=~(sm2[lab]&(yy<H*.62)&(xx<W*.62)&grey0)
    out=nd.gaussian_filter(sky.astype(np.float32),.8)
    Image.fromarray((out*255).astype(np.uint8)).save(f'brm/{i:04d}.png')
if __name__=='__main__':
    ids=[int(a) for a in sys.argv[1:]] or range(1,400)
    with Pool(8) as p:p.map(one,ids)
