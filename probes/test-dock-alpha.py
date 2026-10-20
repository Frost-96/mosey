#!/usr/bin/env python3
"""Public process boundary checks using independent, temporary PNG fixtures."""
import json, pathlib, struct, subprocess, sys, tempfile, zlib
binary=sys.argv[1]
def png(path, rows):
    def chunk(kind,data):
        return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data))
    width=len(rows[0])//4
    data=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',width,len(rows),8,6,0,0,0))
    data+=chunk(b'IDAT',zlib.compress(b''.join(b'\0'+row for row in rows)))+chunk(b'IEND',b'')
    path.write_bytes(data)
def run(*args):
    return subprocess.run([binary,*map(str,args)],capture_output=True,text=True,timeout=10)
with tempfile.TemporaryDirectory(prefix='mosey-alpha-') as directory:
    directory=pathlib.Path(directory)
    assert run(directory/'absent.png','--threshold','128').returncode==66
    transparent=directory/'transparent.png'
    png(transparent,[bytes(16)]*3)
    result=run(transparent,'--threshold','128')
    assert result.returncode==0,result.stderr
    value=json.loads(result.stdout)
    assert value['selectedPixelCount']==0 and value['boundsPixels'] is None and value['inwardContourPixels']==[]
    assert value['supportEdge'] is None
    known=directory/'known.png'
    rows=[bytearray(16) for _ in range(3)]
    for x,y,alpha in [(1,0,255),(2,1,128),(3,2,64)]: rows[y][4*x:4*x+4]=bytes([255,0,0,alpha])
    png(known,rows)
    result=run(known,'--threshold','128')
    assert result.returncode==0,result.stderr
    value=json.loads(result.stdout)
    assert value['boundsPixels']=={'x':1,'y':0,'width':2,'height':2}
    assert value['selectedPixelCount']==2 and value['nonzeroAlphaPixelCount']==3
    assert value['inwardContourPixels']==[{'x':1,'y':0},{'x':2,'y':1}]
    assert value['sourcePixels']['coordinateSpace']=='Image pixels, top-left origin'
    assert value['supportEdge'] is None
if len(sys.argv)>2:
    lookup=subprocess.run([sys.argv[2]],capture_output=True,text=True,timeout=20)
    assert lookup.returncode in [0,2],lookup.stderr
    result=json.loads(lookup.stdout)
    assert result['status'] in ['metadata_only','screen_capture_permission_unavailable','shareable_content_unavailable']
    if lookup.returncode==2: assert result['windows']==[]
    for window in result['windows']:
        assert set(window)=={'windowID','frame','isOnScreen','layer'}
print('PASS: missing file, transparent image, alpha threshold, independently known top-left contour, optional metadata lookup')
