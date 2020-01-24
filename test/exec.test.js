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
                }
            ]
        })
    ],
    method: 'unit',
    config: {
        test: true,
        HttpServerPort: {
            namespace: 'monitoring',
            imports: ['methods']
        }
    },
    params: {
        steps: [
            {
                method: 'monitoring.publish',
                name: 'monitoring publish',
                params: {
                },
                result: (result, assert) => {
                    assert.equals(result, 'result');
                }
            }
        ]
    }
});
