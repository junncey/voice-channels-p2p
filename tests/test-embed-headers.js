'use strict';

// npx mocha test-embed-headers.js
//
// The embed policy is security-relevant (frame-ancestors / X-Frame-Options)
// and buildEmbedCsp/embedPolicyFor are pure — direct unit tests, no server.

require('should');

const configPath = require.resolve('../app/src/config');
const configWasCached = Boolean(require.cache[configPath]);
const { buildEmbedCsp, embedPolicyFor } = require('../app/src/middleware/embedHeaders');
// embedHeaders pulls in config.js, which reads process.env at load — leaving
// it cached would leak THIS file's env into test-server.js (it pins its own
// env before requiring server.js). Hand later suites a fresh evaluation.
if (!configWasCached) delete require.cache[configPath];

describe('test-embed-headers (iframe restrictions)', () => {
    describe('buildEmbedCsp', () => {
        it('should fail closed to same-origin when nothing is configured', () => {
            buildEmbedCsp([]).should.eql({ csp: "frame-ancestors 'self'", xfo: 'SAMEORIGIN' });
            buildEmbedCsp(undefined).should.eql({ csp: "frame-ancestors 'self'", xfo: 'SAMEORIGIN' });
        });

        it("should map 'none' to a full embed block", () => {
            buildEmbedCsp(['none']).should.eql({ csp: "frame-ancestors 'none'", xfo: 'DENY' });
            buildEmbedCsp(["'none'"]).should.eql({ csp: "frame-ancestors 'none'", xfo: 'DENY' });
        });

        it("should map a single 'self' to the same-origin default", () => {
            buildEmbedCsp(['self']).should.eql({ csp: "frame-ancestors 'self'", xfo: 'SAMEORIGIN' });
            buildEmbedCsp(["'SELF'"]).should.eql({ csp: "frame-ancestors 'self'", xfo: 'SAMEORIGIN' });
        });

        it('should implicitly include self alongside configured origins', () => {
            buildEmbedCsp(['https://partner.example']).should.eql({
                csp: "frame-ancestors 'self' https://partner.example",
                xfo: null, // XFO cannot express multiple origins — omit instead of contradicting CSP
            });
        });

        it('should keep several origins and drop self/none/empty entries from the list', () => {
            buildEmbedCsp(['https://a.example', 'https://b.example', 'self', 'none', '   ']).should.eql({
                csp: "frame-ancestors 'self' https://a.example https://b.example",
                xfo: null,
            });
        });
    });

    describe('embedPolicyFor', () => {
        it('should NEVER allow embedding the admin console or its API', () => {
            for (const p of ['/admin', '/api/admin/login', '/api/admin/channels']) {
                embedPolicyFor(p).should.eql({ csp: "frame-ancestors 'none'", xfo: 'DENY' }, p);
            }
        });

        it('should apply the configured policy to every other path', () => {
            embedPolicyFor('/').should.eql(buildEmbedCsp([])); // unconfigured default: same-origin
            embedPolicyFor('/c/talk').should.eql({ csp: "frame-ancestors 'self'", xfo: 'SAMEORIGIN' });
        });
    });
});
