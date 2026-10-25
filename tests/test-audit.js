'use strict';

// npx mocha test-audit.js

require('should');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Audit = require('../app/src/audit');

function tempFile(name) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-audit-'));
    return path.join(dir, `${name}.jsonl`);
}

describe('test-audit', () => {
    let file;
    beforeEach(() => {
        file = tempFile('audit');
    });
    afterEach(() => {
        fs.rmSync(path.dirname(file), { recursive: true, force: true });
    });

    it('should record events and tail them newest-first', () => {
        const audit = new Audit(file);
        audit.record('join', { channel: 'c1', name: 'alice' });
        audit.record('leave', { channel: 'c1', name: 'alice', reason: 'client namespace disconnect' });
        const tail = audit.tail(10);
        tail.should.have.length(2);
        tail[0].event.should.equal('leave');
        tail[1].event.should.equal('join');
        tail[1].channel.should.equal('c1');
        String(tail[1].t).should.match(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should persist across instances and cap field/value sizes', () => {
        const first = new Audit(file);
        first.record('backup', { files: 3 });
        first.record('weird', { big: 'x'.repeat(5000), n: undefined, ok: true });
        const second = new Audit(file);
        const tail = second.tail(10);
        tail.should.have.length(2);
        const weird = tail.find((e) => e.event === 'weird');
        (weird.big.length <= 800).should.be.true();
        should.equal(weird.n, undefined);
        weird.ok.should.equal('true'); // scalars stringify for a greppable file
    });

    it('should survive a torn trailing line', () => {
        fs.writeFileSync(file, '{"event":"a"}\n{"event":"tor', 'utf8');
        const audit = new Audit(file);
        audit.tail(10).should.have.length(1);
        audit.record('b', {});
        const reopened = new Audit(file);
        reopened
            .tail(10)
            .map((e) => e.event)
            .should.eql(['b', 'a']); // torn line skipped on load
    });
});
