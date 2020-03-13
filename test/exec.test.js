const request = require('request');
const joi = require('joi');

require('ut-run').run({
    main: [
        () => ({
            test: () => [
                require('..'),
                function methods() {
                    return {
                        'monitoring.publish'() {
                            return 'result';
                        }
                    };
                },
                function validations() {
                    return {
                        'monitoring.publish'() {
                            return {
                                auth: false,
                                params: joi.object()
                            };
                        }
                    };
                }
            ]
        })
    ],
    method: 'unit',
    config: {
        test: true,
        HttpServerPort: {
            namespace: ['HttpServerPort', 'monitoring'],
            imports: ['methods'],
            api: ['validations'],
            port: 0
        }
    },
    params: {
        steps: [
            {
                method: 'HttpServerPort.status',
                name: 'status',
                params: {},
                result: (result, assert) => {
                    assert.comment(result);
                }
            },
            {
                method: 'monitoring.publish',
                name: 'monitoring publish',
                params: {
                },
                result: (result, assert) => {
                    assert.equals(result, 'result');
                }
            }, {
                name: 'validation',
                params: context => {
                    return new Promise((resolve, reject) => request.post(`http://localhost:${context.status.port}/rpc/monitoring/publish`, {
                        json: true,
                        body: {
                            jsonrpc: '2.0',
                            id: 1
                        }
                    }, (error, response, body) => error ? reject(error) : resolve(body)));
                },
                result: (result, assert) => {
                    assert.matchSnapshot(result, 'Parameters failed validation');
                }
            }
        ]
    }
});
