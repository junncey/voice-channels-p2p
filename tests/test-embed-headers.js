'use strict';

// npx mocha test-embed-headers.js
//
// 嵌入策略涉及安全（frame-ancestors / X-Frame-Options），而
// buildEmbedCsp/embedPolicyFor 都是纯函数——直接单测，无需起服务器。

require('should');

const configPath = require.resolve('../app/src/config');
const configWasCached = Boolean(require.cache[configPath]);
const { buildEmbedCsp, embedPolicyFor } = require('../app/src/middleware/embedHeaders');
// embedHeaders 会引入 config.js，后者在加载时读取 process.env——若把它留在
// require 缓存里，本文件的 env 会泄漏进 test-server.js（它在 require server.js
// 前会先固定自己的 env）。给后续测试套件一个干净的求值环境。
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
                xfo: null, // XFO 表达不了多个来源——宁可省略也不与 CSP 矛盾
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
            embedPolicyFor('/').should.eql(buildEmbedCsp([])); // 未配置时的默认：仅同源
            embedPolicyFor('/c/talk').should.eql({ csp: "frame-ancestors 'self'", xfo: 'SAMEORIGIN' });
        });
    });
});
