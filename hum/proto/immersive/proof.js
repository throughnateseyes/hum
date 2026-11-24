import * as THREE from 'three';
THREE.ColorManagement.enabled=false;
const W=1600,H=900,F=1200,B=60/140,FPS=30;
const C={ink:'#0f141c',cream:'#fff3dc',apricot:'#ffae5c',coral:'#ff4a2b',cobalt:'#2446ff',aqua:'#a6ecf0',butter:'#ffd94a',paper:'#f5f0e6',pink:'#ffb3c7'};
const col=h=>new THREE.Color(h);
const clamp=(x,a=0,b=1)=>Math.min(b,Math.max(a,x)),mix=(a,b,k)=>a+(b-a)*k;
const sm=(a,b,x)=>{x=clamp((x-a)/(b-a));return x*x*(3-2*x)};
const outQ=x=>1-Math.pow(1-clamp(x),4),outC=x=>1-Math.pow(1-clamp(x),3),inC=x=>Math.pow(clamp(x),3);
const backOut=x=>{x=clamp(x);const s=1.5;return 1+(s+1)*Math.pow(x-1,3)+s*Math.pow(x-1,2)};
const rand=n=>{const x=Math.sin(n*127.1+31.7)*43758.5453;return x-Math.floor(x)};
const gl=new THREE.WebGLRenderer({canvas:document.getElementById('c'),antialias:false,preserveDrawingBuffer:true,alpha:false});
gl.setSize(W,H,false);gl.outputColorSpace=THREE.LinearSRGBColorSpace;gl.autoClear=false;
const RT=(o={})=>new THREE.WebGLRenderTarget(W,H,{type:THREE.HalfFloatType,samples:0,depthBuffer:true,...o});
const rtBack=RT({samples:4}),rtFront=RT({samples:4}),rtRoad=RT({samples:4}),rtOne=RT(),rtA=RT(),rtB=RT();
await Promise.all([document.fonts.load('900 100px Arch'),document.fonts.load('600 40px Arch')]);

/* ---------- frames ---------- */
const cache=new Map();
async function tex(dir,i,ext){const k=dir+i;if(cache.has(k)){const v=cache.get(k);cache.delete(k);cache.set(k,v);return v}
  const img=new Image();img.src=`/${dir}/${String(i).padStart(4,'0')}.${ext}`;await img.decode();
  const t=new THREE.Texture(img);t.minFilter=THREE.LinearFilter;t.generateMipmaps=false;t.needsUpdate=true;cache.set(k,t);
  if(cache.size>70){const[o,v]=cache.entries().next().value;v.dispose();cache.delete(o)}return t}
const N=399;
async function bedTex(f){f=clamp(f,1,N-1);const a=Math.floor(f);return{a:await tex('br',a,'jpg'),b:await tex('br',a+1,'jpg'),ma:await tex('brm',a,'png'),mb:await tex('brm',a+1,'png'),k:f-a}}

/* ---------- where the road meets the sky, per clip frame ---------- */
const VP=f=>{const k=[[1,.30,.783],[180,.305,.795],[330,.25,.83],[399,.24,.835]];for(let i=1;i<k.length;i++)if(f<=k[i][0]){const u=(f-k[i-1][0])/(k[i][0]-k[i-1][0]);return[mix(k[i-1][1],k[i][1],u)*W,mix(k[i-1][2],k[i][2],u)*H]}return[.24*W,.835*H]};
const SUN=f=>[.61*W,mix(.655,.705,clamp(f/399))*H];
const DIST=f=>9.8*f/30, TOWER=f=>152-DIST(f);
const cam=new THREE.PerspectiveCamera(2*Math.atan(H/2/F)*180/Math.PI,W/H,.3,600);
function aim(f){const[x,y]=VP(f);cam.setViewOffset(W,H,W/2-x,H/2-y,W,H);cam.position.set(0,1.15,0);cam.rotation.set(0,0,0);cam.updateMatrixWorld();cam.updateProjectionMatrix()}

/* ---------- type ---------- */
function word(txt,{wght=900,wdth=100,px=260,color='#fff',track=0,pad=.04}={}){
  const c=document.createElement('canvas'),x=c.getContext('2d');c.style.fontStretch=wdth+'%';
  const set=()=>{x.font=`${wght} ${px}px Arch`;x.fontStretch=wdth<=62?'ultra-condensed':wdth<=75?'condensed':wdth<=87?'semi-condensed':wdth<=100?'normal':wdth<=112?'semi-expanded':'expanded';x.letterSpacing=(track*px)+'px';x.textBaseline='alphabetic'};
  set();const m=x.measureText(txt);const asc=m.actualBoundingBoxAscent,desc=m.actualBoundingBoxDescent;
  const p=px*pad;c.width=Math.ceil(m.actualBoundingBoxRight+m.actualBoundingBoxLeft+2*p);c.height=Math.ceil(asc+desc+2*p);set();x.fillStyle=color;x.fillText(txt,p+m.actualBoundingBoxLeft,p+asc);
  const t=new THREE.CanvasTexture(c);t.anisotropy=16;t.minFilter=THREE.LinearMipmapLinearFilter;t.generateMipmaps=true;
  return{t,a:c.width/c.height}}
/** a flat word: plane 1 high, a wide, origin at its bottom left */
function wordMesh(txt,o={}){const w=word(txt,o);const g=new THREE.PlaneGeometry(w.a,1);g.translate(w.a/2,.5,0);
  const m=new THREE.Mesh(g,new THREE.ShaderMaterial({transparent:true,depthWrite:false,side:THREE.DoubleSide,uniforms:{t:{value:w.t},c:{value:col(o.color||'#fff')},o:{value:1},wipe:{value:1},zone:{value:0}},
   vertexShader:`varying vec2 u;void main(){u=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
   fragmentShader:`varying vec2 u;uniform sampler2D t;uniform vec3 c;uniform float o,wipe;void main(){float a=texture2D(t,u).a*o*step(u.x,wipe);if(a<.003)discard;gl_FragColor=vec4(c*a,a);}`,blending:THREE.CustomBlending,blendSrc:THREE.OneFactor,blendDst:THREE.OneMinusSrcAlphaFactor}));
  m.ar=w.a;m.visible=false;return m}
const flat=(h,o=1)=>new THREE.MeshBasicMaterial({color:col(h),side:THREE.DoubleSide,transparent:o<1,opacity:o});

/* ---------- the three layers in the scene ---------- */
const back=new THREE.Scene(),front=new THREE.Scene(),road=new THREE.Scene();

// rays from the sun (screen space, behind the bridge)
const rays=new THREE.Mesh(new THREE.PlaneGeometry(2,2),new THREE.ShaderMaterial({depthTest:false,depthWrite:false,transparent:true,blending:THREE.CustomBlending,blendSrc:THREE.OneFactor,blendDst:THREE.OneMinusSrcAlphaFactor,
 uniforms:{s:{value:new THREE.Vector2()},reach:{value:0},rot:{value:0},c1:{value:col(C.cream)},c2:{value:col(C.coral)},seed:{value:0}},
 vertexShader:`varying vec2 u;void main(){u=uv;gl_Position=vec4(position.xy,0.,1.);}`,
 fragmentShader:`varying vec2 u;uniform vec2 s;uniform float reach,rot,seed;uniform vec3 c1,c2;
 float h(float n){return fract(sin(n*91.7+seed*7.1)*4375.5);}
 void main(){vec2 p=(u*vec2(1600.,900.)-s);float r=length(p);float a=atan(p.y,p.x)+rot;float n=22.;float x=a/6.2831853*n;float i=floor(x);i=mod(i,n);float f=fract(x);
 float w=.16+.5*h(i);float px=n/(6.2831853*max(r,1.));float k=smoothstep(0.,px,f-.5+w*.5)*smoothstep(0.,px,.5+w*.5-f);
 float len=reach*1900.*(.55+.75*h(i+40.));k*=smoothstep(len+2.,len,r)*smoothstep(58.,60.,r)*step(.18,h(i+9.));
 float tail=1.;vec3 c=mix(c1,c2,step(.62,h(i+3.)));gl_FragColor=vec4(c*k,k)*tail;}`}));
rays.frustumCulled=false;rays.renderOrder=-5;back.add(rays);

// words
const L={};
L.hold=wordMesh('HOLD',{wdth:125,wght:900,color:C.cream,track:.02});
L.still=wordMesh('STILL',{wdth:125,wght:900,color:C.cream,track:.02});
L.city=wordMesh('THE CITY',{wdth:75,wght:900,color:C.cream});
L.opens=wordMesh('OPENS',{wdth:100,wght:900,color:C.cream});
L.opens2=wordMesh('OPENS',{wdth:75,wght:900,color:C.cream});
L.window=wordMesh('WINDOW',{wdth:87,wght:900,color:C.cream});
L.keep=wordMesh('KEEP',{wdth:125,wght:900,color:C.cream});
L.driving=wordMesh('DRIVING',{wdth:75,wght:900,color:C.cream});
L.home=wordMesh('HOME',{wdth:125,wght:900,color:C.cream,track:.02});
for(const k in L)back.add(L[k]);
const R={};
R.city=wordMesh('CITY',{wdth:100,wght:800});R.opens=wordMesh('OPENS',{wdth:100,wght:800});R.keep=wordMesh('KEEP',{wdth:100,wght:800});R.go=wordMesh('DRIVING',{wdth:87,wght:800});
for(const k in R)road.add(R[k]);

// the wall of cables is a plane at x = WALL_R / WALL_L
const WALL_R=15.5,WALL_L=-9.2;
function onRight(m,z0,h,y,D){m.visible=true;m.scale.set(h,h,1);m.rotation.set(0,-Math.PI/2,0);m.position.set(WALL_R+.2,y,-(z0-D))} // x runs along +z (toward us): far letter first
function onLeft(m,z0,h,y,D){m.visible=true;m.scale.set(h,h,1);m.rotation.set(0,Math.PI/2,0);m.position.set(WALL_L-.2,y,-(z0-D))}
function atDepth(m,z,cx,y,h){m.visible=true;m.scale.set(h,h,1);m.rotation.set(0,0,0);m.position.set(cx-m.ar*h/2,y,-z)}
function onRoad(m,z0,w,len,cx,D){m.visible=true;m.rotation.set(-Math.PI/2,0,0);m.scale.set(w/m.ar,len,1);m.position.set(cx-w/2,.01,-(z0-D))}

/** set so it spans w px, centred on cx, baseline at py, when the clip is at frame f0; then it stays at that place in the world */
function inSky(m,f,f0,behind,cx,py,w,push=1){const z0=TOWER(f0)+behind,[vx,vy]=VP(f0);const s=z0/F,h=w/m.ar*s;m.visible=true;m.rotation.set(0,0,0);m.scale.set(h,h,1);m.position.set((cx-vx)*s-h*m.ar/2,1.15-(py-vy)*s,-(z0-(DIST(f)-DIST(f0)))*push)}
// posts: a row of flat bars standing along the barriers, an equaliser in the street
const postG=new THREE.PlaneGeometry(1,1);postG.translate(0,.5,0);
const posts=[];const postCols=[C.coral,C.cream,C.butter,C.cobalt,C.aqua];
for(const side of[0,1])for(let i=0;i<34;i++){const m=new THREE.Mesh(postG,flat(postCols[(i*2+side)%5]));m.userData={side,i};m.renderOrder=-3;back.add(m);posts.push(m)}

// ribbons: flat bands that corkscrew down the road; the parts outside the cables pass behind them
function ribbon(seed,colr,width,rad,turns,ph){
  const n=420,pos=[],nor=[],al=[],idx=[];const pt=(u)=>{const z=-2-u*230;const a=ph+turns*u*Math.PI*2;const r=rad*(.55+.55*Math.sin(u*5+seed*2)*Math.sin(u*5+seed*2)+.35*u);return (()=>{let y=6.5+Math.sin(a)*r*.82;y=y<4.2?4.2-1.6*Math.tanh((4.2-y)/3):y;return new THREE.Vector3(3.2+Math.cos(a)*r*1.35,y,z)})()};
  for(let i=0;i<=n;i++){const u=i/n,p=pt(u),q=pt(Math.min(1,u+.002));const t=q.clone().sub(p);if(t.lengthSq()<1e-9)t.set(0,0,-1);t.normalize();const tw=seed*3+u*9;const up=new THREE.Vector3(Math.cos(tw),Math.sin(tw),0);const side=new THREE.Vector3().crossVectors(t,up).normalize();
    for(const s of[-1,1]){pos.push(p.x,p.y,p.z);nor.push(side.x*s,side.y*s,side.z*s);al.push(u)}if(i<n){const k=i*2;idx.push(k,k+1,k+2,k+1,k+3,k+2)}}
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setAttribute('sd',new THREE.Float32BufferAttribute(nor,3));g.setAttribute('al',new THREE.Float32BufferAttribute(al,1));g.setIndex(idx);
  const mat=new THREE.ShaderMaterial({side:THREE.DoubleSide,uniforms:{c:{value:col(colr)},w:{value:width},head:{value:0},tail:{value:1},layer:{value:0},tz:{value:200},slide:{value:0}},
   vertexShader:`attribute vec3 sd;attribute float al;varying float a;varying vec3 wp;uniform float w,slide;void main(){a=al;vec3 p=position+sd*w;p.z+=slide;wp=p;gl_Position=projectionMatrix*viewMatrix*vec4(p,1.);}`,
   fragmentShader:`varying float a;varying vec3 wp;uniform vec3 c;uniform float head,tail,layer,tz;void main(){if(a<head||a>tail)discard;float bh=(wp.x>${WALL_R}||wp.x<${WALL_L}||-wp.z>tz)?1.:0.;if(abs(bh-layer)>.5)discard;vec3 k=gl_FrontFacing?c:c*.82;gl_FragColor=vec4(k,1.);}`});
  const A=new THREE.Mesh(g,mat),m2=mat.clone();m2.uniforms.layer.value=1;const Bm=new THREE.Mesh(g,m2);A.frustumCulled=Bm.frustumCulled=false;front.add(A);back.add(Bm);return{f:A,b:Bm}}
const ribs=[ribbon(1,C.coral,.34,8,2.2,0),ribbon(2,C.cream,.2,10,2.6,1.3),ribbon(3,C.cobalt,.28,9,1.8,2.5),ribbon(4,C.butter,.16,12,3,3.6),ribbon(5,C.aqua,.22,11,2.1,4.6),ribbon(6,C.coral,.09,7,3.4,5.4),ribbon(7,C.cream,.07,13,2.4,.6)];

// plus signs thrown outward
const plusG=new THREE.PlaneGeometry(1,1);plusG.rotateX(-Math.PI/2);const pluses=[];for(let i=0;i<64;i++){const m=new THREE.Mesh(plusG,flat(postCols[i%5]));front.add(m);pluses.push(m)}

/* ---------- the white scene ---------- */
const white=new THREE.Scene();const panels=[];
const panMat=()=>new THREE.MeshBasicMaterial({color:0xffffff,side:THREE.DoubleSide});
const pg=new THREE.PlaneGeometry(1,1);
for(let i=0;i<26;i++){const photo=i%3!==1;const m=new THREE.Mesh(pg,photo?panMat():flat([C.coral,C.cobalt,C.butter,C.aqua,C.pink][i%5]));m.userData={photo,i};white.add(m);panels.push(m)}
const last=new THREE.Mesh(pg,panMat());white.add(last);
const guides=[];for(let i=0;i<26;i++){const g=new THREE.BoxGeometry(.02,.02,400);const m=new THREE.Mesh(g,flat(i%5?C.ink:C.coral));const a=i/26*6.283+rand(i)*.2,r=3+rand(i+5)*7;m.position.set(Math.cos(a)*r*1.5,Math.sin(a)*r,-190);white.add(m);guides.push(m)}
const wrib=[];for(let k=0;k<5;k++){const pts=[];for(let i=0;i<=60;i++){const u=i/60,a=k*.42+u*11;pts.push(new THREE.Vector3(Math.cos(a)*(5.5+k*.35),Math.sin(a)*(3.4+k*.3),-4-u*120))}
  const g=new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts),500,.07+.03*(k%3),6);const m=new THREE.Mesh(g,flat([C.coral,C.cobalt,C.butter,C.aqua,C.ink][k]));white.add(m);wrib.push(m)}
const wl={like:wordMesh('LIKE',{wdth:125,wght:900,color:C.ink}),a:wordMesh('A',{wdth:125,wght:900,color:C.ink})};for(const k in wl){white.add(wl[k]);wl[k].material.depthTest=false;wl[k].renderOrder=9}
const wcam=new THREE.PerspectiveCamera(2*Math.atan(H/2/F)*180/Math.PI,W/H,.1,400);

/* ---------- compositing ---------- */
const quad=new THREE.Mesh(new THREE.PlaneGeometry(2,2));quad.frustumCulled=false;const qs=new THREE.Scene();qs.add(quad);const qc=new THREE.OrthographicCamera(-1,1,1,-1,0,1);
const VS=`varying vec2 u;void main(){u=uv;gl_Position=vec4(position.xy,0.,1.);}`;
const bedMat=new THREE.ShaderMaterial({depthTest:false,depthWrite:false,uniforms:{a:{value:null},b:{value:null},ma:{value:null},mb:{value:null},k:{value:0},tb:{value:null},tf:{value:null},tr:{value:null},sky0:{value:col(C.apricot)},sky1:{value:col(C.apricot)},hi:{value:col(C.cream)},wipe:{value:1},sun:{value:new THREE.Vector2()},flatK:{value:0},dark:{value:0},inkK:{value:0},roadC:{value:col(C.cobalt)},roadK:{value:0},edge:{value:0},edgeC:{value:col(C.cream)},vp:{value:new THREE.Vector2()},zoom:{value:1},drain:{value:0}},
 vertexShader:VS,fragmentShader:`varying vec2 u;uniform sampler2D a,b,ma,mb,tb,tf,tr;uniform float k,wipe,flatK,dark,inkK,roadK,edge,zoom,drain;uniform vec3 sky0,sky1,hi,roadC,edgeC;uniform vec2 sun,vp;
 float lum(vec3 c){return dot(c,vec3(.3,.59,.11));}
 float msk(vec2 q){return mix(texture2D(ma,q).r,texture2D(mb,q).r,k);}
 void main(){vec2 q=vp+(u-vp)/zoom;vec3 f=mix(texture2D(a,q).rgb,texture2D(b,q).rgb,k);float m=msk(q);float l=lum(f);
  vec2 P=(q-sun)*vec2(1600.,900.);float r=length(P);float w=smoothstep(wipe*2000.,wipe*2000.-2.5,r);vec3 sk=mix(sky0,sky1,w);
  // clouds keep their own shapes, as hard-edged flat tones
  float bl=0.;for(int i=0;i<8;i++){float t=float(i)*.7854;bl+=lum(texture2D(a,q+vec2(cos(t),sin(t))*vec2(3.,5.3)/1600.*1.4).rgb);}bl=mix(l,bl/8.,.75);
  float warm=f.r-f.b;float e=.012;
  float bright=smoothstep(.70-e,.70+e,bl);float darkC=smoothstep(.47+e,.47-e,bl);
  vec3 fs=mix(sk,mix(sk,hi,.62),bright);fs=mix(fs,sk*.74,darkC);
  vec3 nat=f*mix(1.,.62,dark);nat=mix(nat,vec3(lum(nat))*vec3(.8,.95,1.12),dark*.35);
  vec3 sky=mix(nat,fs,flatK);
  vec4 tbk=texture2D(tb,u);sky=sky*(1.-tbk.a)+tbk.rgb;
  // the bridge, the road and the cars stay footage
  float c2=smoothstep(.02,.78,l);vec3 st=f;vec3 g=mix(f,f*f*(3.-2.*f),.55)*1.08;st=mix(nat,g,flatK);
  st=mix(st,mix(vec3(.05,.07,.11),vec3(1.,.95,.86),pow(c2,1.25)),inkK);
  float isRoad=smoothstep(vp.y+.005,vp.y-.03,q.y);float sat=max(f.r,max(f.g,f.b))-min(f.r,min(f.g,f.b));float asph=isRoad*(1.-smoothstep(.10,.2,sat))*smoothstep(.10,.17,l);
  st=mix(st,roadC*(.30+l*2.1),asph*roadK);
  vec4 rd=texture2D(tr,u);float sh=.55+l*1.6;float keep=rd.a*(isRoad)*smoothstep(.07,.15,l)*.94;st=mix(st,rd.rgb/max(rd.a,.001)*clamp(sh,.0,1.15),keep);
  vec3 c=mix(st,sky,m);
  if(edge>0.){vec2 d=vec2(1.6/1600.,1.6/900.);float gx=msk(q+vec2(d.x,0.))-msk(q-vec2(d.x,0.)),gy=msk(q+vec2(0.,d.y))-msk(q-vec2(0.,d.y));float ed=smoothstep(.25,.7,length(vec2(gx,gy)));c=mix(c,edgeC,ed*edge);}
  vec4 fr=texture2D(tf,u);c=c*(1.-fr.a)+fr.rgb;
  gl_FragColor=vec4(c,1.);}`});
const addMat=new THREE.ShaderMaterial({depthTest:false,depthWrite:false,uniforms:{p:{value:null},n:{value:null},w:{value:1},first:{value:1}},vertexShader:VS,fragmentShader:`varying vec2 u;uniform sampler2D p,n;uniform float w,first;void main(){vec3 x=texture2D(n,u).rgb*w;gl_FragColor=vec4(first>.5?x:texture2D(p,u).rgb+x,1.);}`});
const outMat=new THREE.ShaderMaterial({depthTest:false,depthWrite:false,uniforms:{t:{value:null},s:{value:0},fl:{value:0}},vertexShader:VS,fragmentShader:`varying vec2 u;uniform sampler2D t;uniform float s,fl;float h(vec2 p){return fract(sin(dot(p,vec2(12.98,78.23))+s)*43758.5);}void main(){vec3 c=texture2D(t,u).rgb;c=mix(c,vec3(1.,.97,.92),fl);c+=(h(floor(u*vec2(1600.,900.)))-.5)*.028;gl_FragColor=vec4(c,1.);}`});
const pass=(mat,target)=>{quad.material=mat;gl.setRenderTarget(target);gl.render(qs,qc)};
const card=document.createElement('canvas');card.width=W;card.height=H;const cardT=new THREE.CanvasTexture(card);
const cardMat=new THREE.ShaderMaterial({depthTest:false,uniforms:{t:{value:cardT}},vertexShader:VS,fragmentShader:`varying vec2 u;uniform sampler2D t;void main(){gl_FragColor=texture2D(t,u);}`});

/* ---------- time ---------- */
// where the clip is at song time t (in beats): still, then bursts on each bar that settle
const hitDecay=(b,h,d)=>b<h?0:Math.exp(-(b-h)/d);
function clipAt(b){
  if(b<8) return 4+46*outC(b/8);                       // coasting to a stop
  if(b<16){let f=62;for(let i=0;i<4;i++){const h=8+i*2;if(b>h)f+= (i%2?22:40)*outQ((b-h)/2)+ 1.5*Math.min(2,b-h)}return f}
  if(b<20) return 205;
  if(b<28){let f=206;for(let i=0;i<4;i++){const h=20+i*2;if(b>h)f+=(i%2?26:44)*outQ((b-h)/2)+2*Math.min(2,b-h)}return f}
  return Math.min(398,372+26*outC((b-28)/4));
}
const SKY=[[8,C.apricot,C.cream],[10,C.cobalt,C.aqua],[12,C.aqua,C.cream],[14,C.butter,C.cream],[20,C.coral,C.butter],[22,C.aqua,C.cream],[24,C.cobalt,C.pink],[25,C.apricot,C.cream],[26,C.butter,C.cream],[27,C.coral,C.butter]];
function skyAt(b){let i=-1;for(let j=0;j<SKY.length;j++)if(b>=SKY[j][0])i=j;if(i<0)return{c0:C.apricot,c1:C.apricot,hi:C.cream,w:1};const s=SKY[i],p=SKY[Math.max(0,i-1)];const cut=s[0]===8||s[0]===20;return{c0:cut?s[1]:p[1],c1:s[1],hi:s[2],w:cut?1:outC((b-s[0])/.55)*1.02}}
let lastPanels=false;
async function one(t,target){
  const b=t/B;
  if(b>=7&&b<8){const x=card.getContext('2d');x.fillStyle='#090a0c';x.fillRect(0,0,W,H);x.font='500 34px Arch';x.fillStyle=C.cream;x.textAlign='center';x.letterSpacing='2px';if(b>7.15)x.fillText('now',W/2,H/2+10);cardT.needsUpdate=true;pass(cardMat,target);return 0}
  if(b>=16&&b<20)return whiteShot(b,target);
  const f=clipAt(b),D=DIST(f),tz=TOWER(f);aim(f);
  const[vx,vy]=VP(f),[sx,sy]=SUN(f);
  for(const k in L)L[k].visible=false;for(const k in R)R[k].visible=false;
  const drop=b>=8, A=b>=8&&b<16, Z=b>=20&&b<28;
  const set=(m,h)=>m.material.uniforms.c.value.set(h);
  /* words */
  const base=DIST(clipAt(8.001)),base2=DIST(clipAt(20));
  if(b<4){const k=b/4;inSky(L.hold,f,4,18,790,585,1400);L.hold.material.uniforms.o.value=sm(.1,.9,b);set(L.hold,C.cream)}
  else if(b<7){inSky(L.still,f,4,18,790,585,1400);L.still.material.uniforms.o.value=1;set(L.still,C.coral)}
  if(A){
    if(b<12){const p=backOut((b-8)/.7);onRight(L.city,base+94,11*p,5,D);set(L.city,b<10?C.cobalt:C.cream)}
    else {
      const p=outQ((b-12)/.6);inSky(L.opens,f,clipAt(12.001),16,770,560,1230,mix(2.6,1,p));set(L.opens,b<14?C.cobalt:C.coral)}
    
    if(b>=12)onRoad(R.opens,base+53,3.7,17,.35,D);set(R.opens,C.cream);
  }
  if(Z){
    if(b<24){const p=outQ((b-20)/.8);inSky(L.window,f,206,26,790,540,1150,mix(2.4,1,p));set(L.window,b<22?C.cream:C.coral)}
    else{const p=backOut((b-24)/.6);onRight(L.driving,DIST(clipAt(24.001))+77,11*p,6.5,D);set(L.driving,b<25?C.butter:b<26?C.cobalt:C.coral)}
    
  }
  if(b>=28){const z=Math.max(30,tz+20);inSky(L.home,f,clipAt(28.01),60,1215,400,560);set(L.home,C.cream);L.home.material.uniforms.o.value=sm(28.2,29.2,b)*(1-sm(31.2,31.9,b))}
  /* rays */
  rays.visible=(b>=14&&b<16)||(b>=24&&b<28);const rh=b<16?14:24;
  rays.material.uniforms.s.value.set(sx,H-sy);rays.material.uniforms.reach.value=outC((b-rh)/1.4);rays.material.uniforms.rot.value=(b-rh)*.05;rays.material.uniforms.seed.value=b<16?1:Math.floor(b);
  rays.material.uniforms.c1.value.set(b<16?C.cream:b<25?C.aqua:C.cream);rays.material.uniforms.c2.value.set(b<16?C.coral:b<25?C.coral:C.cobalt);
  /* posts rise from far to near */
  for(const m of posts){const{side,i}=m.userData;const on=(A&&b>=10)||(Z&&b>=22);m.visible=on;if(!on)continue;const h0=A?10:22;
    const sp=5;const off=((D)%sp);const z=8+i*sp-off;const id=i+Math.floor(D/sp);const wave=backOut(clamp((b-h0)*2.2-(1-z/170)*2.0,0,1));
    const beatK=Math.exp(-((b%1))/.35);const ht=(2.0+6.5*rand(id*3+side*50)+3.2*beatK*rand(id+9))*wave;
    m.scale.set(1.1,Math.max(.001,ht),1);m.position.set(side?18.5:-12,1.2,-z);m.rotation.y=side?-.55:.55;m.material.color.set(postCols[((id%5)+5)%5])}
  /* ribbons */
  ribs.forEach((r,i)=>{const on=(A||Z);const h0=A?8:20;for(const m of[r.f,r.b]){m.visible=on;const un=m.material.uniforms;const tt=(b-h0);const per=3.4+i*.35,q=((tt+8-i*.55)%per)/per,on2=tt>i*.18;const hd=1-outC(q)*1.25;un.head.value=on2?hd:2;un.tail.value=hd+.12+.22*Math.sin(Math.PI*Math.min(1,q*1.2));un.tz.value=tz;un.slide.value=(D-(A?base:base2))*.75;
     un.w.value=[.26,.16,.22,.13,.18,.08,.07][i]*(1+.6*Math.exp(-(b%2)/.4))}});
  /* plus signs */
  pluses.forEach((m,i)=>{let on=false;for(const h of[8,12,20,24]){const q=(b-h)-rand(i)*.5;if(q>=0&&q<2.6){on=true;const a=rand(i+7)*6.283,rr=3.5+9*rand(i+13);const k=outC(q/2.2);const z=mix(130,3,k)-q*2;m.position.set(2+Math.cos(a)*rr*1.3,Math.max(.4,5+Math.sin(a)*rr*.7),-Math.max(1,z));m.rotation.z=a+1.57;const len=(1.5+9*(1-k))*(.6+rand(i+2));m.scale.set(.06+.12*rand(i+3),1,len);if(z<2)on=false}}m.visible=on});
  /* bed */
  const bt=await bedTex(f),u=bedMat.uniforms;u.a.value=bt.a;u.b.value=bt.b;u.ma.value=bt.ma;u.mb.value=bt.mb;u.k.value=bt.k;
  const sk=skyAt(b);u.sky0.value.set(sk.c0);u.sky1.value.set(sk.c1);u.hi.value.set(sk.hi);u.wipe.value=sk.w;u.sun.value.set(sx/W,1-sy/H);u.vp.value.set(vx/W,1-vy/H);
  u.flatK.value=A||Z?1:b>=28?1-sm(28,29.6,b):0;u.dark.value=b<8?mix(.55,.8,sm(0,7,b)):b>=28?sm(28,30,b)*.6:0;
  u.roadK.value=(b>=10&&b<12)||(b>=14&&b<16)||(b>=22&&b<24)||(b>=26&&b<28)?.85:0;u.roadC.value.set(b<12?C.cobalt:b<16?C.coral:b<24?C.cobalt:C.cobalt);
  let ed=0;for(const h of[10,14,22,25,26,27])ed=Math.max(ed,hitDecay(b,h,.22));u.edge.value=(A||Z)?ed*.95:0;
  let zo=1;for(const[h,a]of[[8,.22],[10,.05],[12,.1],[14,.06],[20,.18],[22,.06],[24,.12],[26,.07]])if(b>=h)zo+=a*Math.exp(-(b-h)/.3);u.zoom.value=b<7?1+.02*b/7:zo;
  // the 3D layers zoom with the picture
  const z=u.zoom.value;cam.setViewOffset(W*z,H*z,(W*z/2-vx)+vx*0-0*(z),(H*z/2-vy),W,H);cam.updateProjectionMatrix();
  rays.material.uniforms.s.value.set(vx+(sx-vx)*z,H-(vy+(sy-vy)*z));
  gl.setClearColor(0,0);
  gl.setRenderTarget(rtBack);gl.clear();gl.render(back,cam);gl.setRenderTarget(rtFront);gl.clear();gl.render(front,cam);gl.setRenderTarget(rtRoad);gl.clear();gl.render(road,cam);
  u.tb.value=rtBack.texture;u.tf.value=rtFront.texture;u.tr.value=rtRoad.texture;pass(bedMat,target);
}
async function whiteShot(b,target){
  const k=(b-16)/4;const end=150;const go=b<19?outQ((b-16)/1.4)*46+ (b-16)*9 : 0;const g19=outQ(3/1.4)*46+27;
  const camZ=b<18.6?(outQ((b-16)/1.4)*46+(b-16)*9):mix(outQ(2.6/1.4)*46+2.6*9,end-10.0*1.2,Math.pow(clamp((b-18.6)/1.4),2.6));
  wcam.position.set(0,0,-camZ);wcam.rotation.set(0,0,mix(.35,0,outC((b-16)/3.2)));wcam.updateMatrixWorld();
  for(const m of panels){const i=m.userData.i;const a=i*2.399+.4,r=4.6+1.4*rand(i);const z=10+i*5.0;const pop=backOut((b-16-i*.035)/.5);m.position.set(Math.cos(a)*r*1.55,Math.sin(a)*r*.9,-z);const s=(2.2+2.6*rand(i+2))*Math.max(.001,pop);m.scale.set(m.userData.photo?s*1.78:s*(.5+rand(i+4)),s,1);
    m.rotation.set(0,m.position.x>0?-.45:.45,0)}
  last.position.set(0,0,-end);last.scale.set(16,9,1);
  for(const m of guides)m.scale.z=1;
  wl.like.visible=b<18.1;wl.a.visible=b>=17;wl.like.scale.setScalar(6.2);wl.like.position.set(-wl.like.ar*3.1,-3.1,-94);
  wl.a.scale.setScalar(5);wl.a.position.set(-wl.a.ar*2.5,-2.5,-112);wl.a.visible=b>=18.1&&b<19.5;
  gl.setRenderTarget(rtFront);gl.setClearColor(col(C.paper),1);gl.clear();gl.render(white,wcam);gl.setClearColor(0,0);
  cardMat.uniforms.t.value=rtFront.texture;pass(cardMat,target);cardMat.uniforms.t.value=cardT}
async function frame(t,subs=6,shutter=.5,still=false){
  let p=rtA,n=rtB;
  for(let s=0;s<subs;s++){await one(Math.max(0,t+(s/subs)*shutter/FPS),rtOne);addMat.uniforms.p.value=p.texture;addMat.uniforms.n.value=rtOne.texture;addMat.uniforms.w.value=1/subs;addMat.uniforms.first.value=s===0?1:0;pass(addMat,n);[p,n]=[n,p]}
  const b=t/B;let fl=0;for(const h of[8,16,20])if(b>=h)fl=Math.max(fl,.85*Math.exp(-(b-h)/.10));if(b>31.4||still)fl=0;
  outMat.uniforms.t.value=p.texture;outMat.uniforms.s.value=Math.floor(t*FPS)%61;outMat.uniforms.fl.value=fl;pass(outMat,null)}
const grab=async(b)=>{await frame(b*B,1,.5,true);const c=document.createElement('canvas');c.width=W;c.height=H;c.getContext('2d').drawImage(document.getElementById('c'),0,0);const t=new THREE.CanvasTexture(c);t.anisotropy=8;return t};
{const bs=[2,8.9,10.6,5.5,12.7,14.5,21.4,9.6,11.5,3,13.6,15.4,24.6,22.6,26.5,6,10.2];const ts=[];for(const b of bs)ts.push(await grab(b));let n=0;for(const m of panels)if(m.userData.photo)m.material=new THREE.MeshBasicMaterial({map:ts[n++%ts.length],side:THREE.DoubleSide});last.material=new THREE.MeshBasicMaterial({map:await grab(20.6)})}
window.shot=async(t,subs)=>{await frame(t,subs);return document.getElementById('c').toDataURL('image/jpeg',.95)};
window.ready=true;
