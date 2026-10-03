import asyncio,sys,unittest
from unittest.mock import patch
from aiohttp import web
from control import EscapeControl,validate_target,_ps_literal,_powershell,_ANSI
from pathlib import Path
class ValidationTests(unittest.TestCase):
 def test_rejects_invalid_targets(self):
  for session,pane in [('',1),('..',1),('main\n',1),('a/b',1),('a\\b',1),('__switchboard_control_x',1),('main',True),('main',-1),('main',2**32),('main','terminal_1')]:
   with self.assertRaises(web.HTTPBadRequest):validate_target(session,pane)
 def test_safe_literals_and_ansi_marker(self):
  validate_target("a'$(echo danger)`",3)
  self.assertEqual(_ps_literal("a'$(echo danger)`"),"'a''$(echo danger)`'")
  self.assertEqual(_ANSI.sub('', '\x1b]8;;\x1b\\prefix\x1b[22m__SB_test:0:END\x1b]8;;\x1b\\'), 'prefix__SB_test:0:END')
  self.assertNotIn('__SB_test',_powershell("[Console]::WriteLine('__SB_test')"))
 def test_launchagent_binary_fallback(self):
  host=type('Host',(),{'config':{'url':'http://127.0.0.1:8082'}})()
  with patch('control.shutil.which',return_value=None):self.assertEqual(EscapeControl(host).binary,str(Path.home()/'.cargo/bin/zellij'))
class TransportTests(unittest.IsolatedAsyncioTestCase):
 async def test_enter_is_separate_and_timeout_never_retries_escape(self):
  class Socket:
   def __init__(self):self.sent=[]
   async def send_bytes(self,data):self.sent.append(data)
  host=type('Host',(),{'config':{'url':'https://172.20.10.69:8082'}})()
  c=EscapeControl(host);c.terminal=Socket();c.helper='__switchboard_control_test';c.state={'session_name':c.helper,'active_pane':{'pane_id':0,'is_plugin':False}}
  async def timeout(future,timeout):future.cancel();raise asyncio.TimeoutError
  with patch('control.asyncio.wait_for',timeout):
   with self.assertRaises(web.HTTPGatewayTimeout):await c._command("& zellij -s 'disposable' action write -p 0 27; $code = $LASTEXITCODE")
  self.assertEqual(len(c.terminal.sent),2);self.assertEqual(c.terminal.sent[1],b'\r');self.assertNotIn(b'\r',c.terminal.sent[0])



class ArtifactTests(unittest.IsolatedAsyncioTestCase):
 async def test_partial_stream_never_writes_a_second_status(self):
  from aiohttp import ClientSession,ClientTimeout
  from aiohttp.test_utils import TestServer
  from server import artifact_proxy
  async def broken(request):
   response=web.StreamResponse();await response.prepare(request);await response.write(b'partial')
   await asyncio.sleep(.01);request.transport.abort();return response
  source=web.Application();source.router.add_get('/{path:.*}',broken)
  async with TestServer(source) as upstream,ClientSession(timeout=ClientTimeout(total=2)) as client:
   relay=web.Application();relay['config']={'target':str(upstream.make_url('/')).rstrip('/'),'hostname':'example.test'};relay['client']=client
   relay.router.add_get('/{path:.*}',artifact_proxy)
   async with TestServer(relay) as proxy:
    reader,writer=await asyncio.open_connection(proxy.host,proxy.port)
    writer.write(b'GET / HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\n\r\n');await writer.drain()
    with self.assertLogs("aiohttp.server",level="ERROR"):
     data=await asyncio.wait_for(reader.read(),3)
    writer.close();await writer.wait_closed()
    self.assertEqual(data.count(b'HTTP/1.1'),1);self.assertNotIn(b'502',data)

if __name__=='__main__':unittest.main()
