import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { CallbackListener } from '../oauth-callback.js';
import { beginAuthorization, REDIRECT_URI } from '../gmail.js';

const execute = (command,args) => new Promise((resolve,reject) => {
  const child = spawn(command,args,{env:{}});
  let stdout='',stderr='';
  child.stdout.on('data',chunk => stdout+=chunk); child.stderr.on('data',chunk => stderr+=chunk);
  child.on('error',reject); child.on('close',code => resolve({code,stdout,stderr}));
});
const pending = () => beginAuthorization({clientId:'123456-test.apps.googleusercontent.com',clientSecret:'synthetic'}).pending;

test('real loopback listener is ready before launch, validates state and returns callback once', async () => {
  const auth = pending(), listener = new CallbackListener(auth,{execute});
  try {
    await listener.start();
    assert.equal(await listener.poll(),null);
    assert.equal((await fetch(`${REDIRECT_URI}?state=wrong&code=test`)).status,400);
    assert.equal((await fetch('http://127.0.0.1:9481/result')).status,403);
    assert.equal((await fetch('http://127.0.0.1:9481/result',{headers:{Origin:'https://example.com','X-Folio-State':auth.state}})).status,403);
    assert.equal((await fetch(`${REDIRECT_URI}?state=${auth.state}&code=test&code=duplicate`)).status,400);
    assert.equal((await fetch(REDIRECT_URI,{method:'POST'})).status,404);
    const callback=`${REDIRECT_URI}?state=${auth.state}&code=synthetic-code`;
    const page=await fetch(callback);
    assert.equal(page.status,200); assert.match(await page.text(),/Authorization received/);
    assert.equal(page.headers.get('cache-control'),'no-store');
    assert.equal(await listener.poll(),callback);
  } finally { await listener.stop(); }
});

test('cancel releases the port for another login; port conflicts do not launch a second listener', async () => {
  const first = new CallbackListener(pending(),{execute});
  const second = new CallbackListener(pending(),{execute});
  try {
    await first.start();
    await assert.rejects(second.start(),error => error.code==='listener_failed' && /port is in use/.test(error.message));
    await first.stop();
    await second.start();
    assert.equal(await second.poll(),null);
  } finally { await first.stop(); await second.stop(); }
});

test('Google cancellation is returned as a typed OAuth error and listener can be stopped',async () => {
  const auth=pending(), listener=new CallbackListener(auth,{execute});
  try {
    await listener.start();
    await fetch(`${REDIRECT_URI}?state=${auth.state}&error=access_denied`);
    await assert.rejects(listener.poll(),error => error.code==='auth_cancelled');
  } finally { await listener.stop(); }
});
