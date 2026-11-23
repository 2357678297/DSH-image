// Real Canvas 2D in the browser; measured RGBA means getImageData() after browser decode/upload,
// not original PNG file bytes (fully transparent RGB and low-alpha colour can be quantized).
export async function auditGridPixels({ui, check}) {
  const {psGridLayout: layout, psGridCrop: crop, psGridReplace: replace} = ui;
  const canvas = (w, h, pixel) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(w, h);
    for (let y=0; y<h; y++) for (let x=0; x<w; x++) img.data.set(pixel(x,y), 4*(y*w+x));
    ctx.putImageData(img, 0, 0); return c;
  };
  const read = (c, x=0, y=0, w=c.width, h=c.height) => c.getContext('2d').getImageData(x,y,w,h).data;
  const equal = (a,b) => a.length === b.length && a.every((v,i) => v === b[i]);
  const rejects = f => {try {f(); return false;} catch(e) {return e instanceof RangeError || e instanceof TypeError;}};
  const width = 23, height = 17;
  let allCovered = true;
  for (let rows=1; rows<=6; rows++) for (let cols=1; cols<=6; cols++) {
    const hit = new Uint8Array(width*height), cells = layout(width,height,rows,cols);
    allCovered &&= cells.length === rows*cols && cells.every(({x,y,w,h},i) => {
      for (let j=y; j<y+h; j++) for (let k=x; k<x+w; k++) hit[j*width+k]++;
      return [x,y,w,h].every(Number.isInteger) && w>0 && h>0 && x>=0 && y>=0 && x+w<=width && y+h<=height &&
        (i%cols===0 ? x===0 : x===cells[i-1].x+cells[i-1].w) && (i<cols ? y===0 : y===cells[i-cols].y+cells[i-cols].h);
    }) && hit.every(n=>n===1);
  }
  check('23×17 余数尺寸：全部 36 种行列配置按行优先完整覆盖，每像素恰属一格', allCovered);
  check('单像素格及单格整图的极值', layout(6,6,6,6).every(r=>r.w===1 && r.h===1) && JSON.stringify(layout(1,1,1,1))==='[{"x":0,"y":0,"w":1,"h":1}]');
  const source = canvas(width,height,(x,y)=>[(x*57+y*11)%256,(x*7+y*32)%256,(x*13+y*97)%256,[0,1,16,64,127,191,254,255][(x+y)%8]]);
  const original = read(source);
  const cells = layout(width,height,3,4);
  const reassembled = new Uint8ClampedArray(original.length);
  for (const r of cells) {
    const tile = crop(source,r), bytes = read(tile);
    for(let y=0; y<r.h; y++) reassembled.set(bytes.subarray(4*y*r.w,4*(y+1)*r.w),4*((r.y+y)*width+r.x));
  }
  check('半透明和极低 alpha 源图：12 格读回后，逐行拼回与源画布可见 RGBA 相同', equal(reassembled,original));
  const box = {x:5,y:3,w:4,h:4};
  const patch = canvas(8,4,(x,y)=>[x*32, y*65, x*16, [255,64,127,255,0,191,254,255][x]]);
  const beforePatch = read(patch), result = replace(source,box,patch), after = read(result);
  let outside = true;
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
    if (x>=box.x && y>=box.y && x<box.x+box.w && y<box.y+box.h) continue;
    const start=4*(y*width+x); outside &&= equal(after.subarray(start,start+4), original.subarray(start,start+4));
  }
  check('只改选中格：其他 375 像素含半透明 RGBA 不变，返回独立原尺寸画布', result!==source && result.width===width && result.height===height && outside);
  check('宽补丁居中 cover；半透明不是叠加，全透明能擦掉底图', equal(read(result,box.x,box.y,box.w,box.h),read(patch,2,0,4,4)));
  check('源画布和补丁对象均未修改', equal(original,read(source)) && equal(beforePatch,read(patch)));
  const tall = canvas(2,6,(x,y)=>[y===2?255:0,y===3?255:0,y<2||y>3?255:0,255]);
  const img = new Image();
  await new Promise((resolve, reject) => { img.onload=resolve; img.onerror=reject; img.src=tall.toDataURL('image/png'); });
  // CSS/HTML display sizes are not intrinsic pixel dimensions.
  img.width = 20; img.height = 1;
  const filled = read(replace(source,box,img),box.x,box.y,4,4);
  const px=i=>Array.from(filled.subarray(i*4,i*4+4));
  check('窄高图取自然尺寸居中裁切并放大：画面顶部红、底部绿、左右不留边', [0,3].every(i=>px(i)[0]>px(i)[2] && px(i)[3]===255) && [12,15].every(i=>px(i)[1]>px(i)[2] && px(i)[3]===255));
  check('拒绝非整数、非有限、超过 6 或源像素不足的网格', [[2,2,3,1],[2,2,1,3],[100,100,1,7],[4,4,1.5,2],[0,4,1,1],[4,Infinity,1,1],[2,2,NaN,1]].every(args=>rejects(()=>layout(...args))));
  check('越界、分数和零面积不做截断；空补丁或空源报错', [null,{x:-1,y:0,w:1,h:1},{x:width,y:0,w:1,h:1},{x:0,y:0.5,w:1,h:1},{x:0,y:0,w:1,h:0}].every(r=>rejects(()=>crop(source,r)) && rejects(()=>replace(source,r,patch))) && rejects(()=>replace(source,box,new Image())) && rejects(()=>crop(null,box)));
}
