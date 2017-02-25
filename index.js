/* eslint no-underscore-dangle: ["error", { "allowAfterThis": true }] */

'use strict';

const Breaker = require('circuit-fuses');
const Request = require('request');
const Hoek = require('hoek');
const Joi = require('joi');
const Schema = require('screwdriver-data-schema');
const Scm = require('screwdriver-scm-base');

const DEFAULT_AUTHOR = {
    avatar: 'https://cd.screwdriver.cd/assets/unknown_user.png',
    name: 'n/a',
    username: 'n/a',
    url: 'https://cd.screwdriver.cd/'
};

const MATCH_COMPONENT_HOSTNAME = 1;
const MATCH_COMPONENT_USER = 2;
const MATCH_COMPONENT_BRANCH = 4;
const MATCH_COMPONENT_REPO = 3;

const WEBHOOK_PAGE_SIZE = 30;
const STATE_MAP = {
    SUCCESS: 'success',
    RUNNING: 'pending',
    QUEUED: 'pending'
};
const DESCRIPTION_MAP = {
    SUCCESS: 'Everything looks good!',
    FAILURE: 'Did not work as expected.',
    ABORTED: 'Aborted mid-flight',
    RUNNING: 'Testing your code...',
    QUEUED: 'Looking for a place to park...'
};

/**
 * Check the status code of the server's response.
 *
 * If there was an error encountered with the request, this will format a human-readable
 * error message.
 * @method checkResponseError
 * @param  {HTTPResponse}   response                               HTTP Response from `request` call
 * @param  {Number}         response.statusCode                    HTTP status code of the HTTP request
 * @param  {String}         [response.body.error.message]          Error message from the server
 * @param  {String}         [response.body.error.detail.required]  Error resolution message
 * @return {Promise}                                               Resolves when no error encountered.
 *                                                                 Rejects when status code is non-200
 */
function checkResponseError(response) {
    if (response.statusCode >= 200 && response.statusCode < 300) {
        return;
    }

    const errorMessage = Hoek.reach(response, 'body.error.message', {
        default: `SCM service unavailable (${response.statusCode}).`
    });
    const errorReason = Hoek.reach(response, 'body.error.detail.required', {
        default: JSON.stringify(response.body)
    });

    throw new Error(`${errorMessage} Reason "${errorReason}"`);
}

/**
* Get repo information
* @method getRepoInfo
* @param  {String}  checkoutUrl      The url to check out repo
* @return {Object}                   An object with the hostname, repo, branch, and username
*/
function getRepoInfo(checkoutUrl) {
    const regex = Schema.config.regex.CHECKOUT_URL;
    const matched = regex.exec(checkoutUrl);

    return {
        hostname: matched[MATCH_COMPONENT_HOSTNAME],
        repo: matched[MATCH_COMPONENT_REPO],
        branch: matched[MATCH_COMPONENT_BRANCH].slice(1),
        username: matched[MATCH_COMPONENT_USER]
    };
}

class GitlabScm extends Scm {
    /**
    * Constructor
    * @method constructor
    * @param  {Object}  options                         Configuration options
    * @param  {String}  [options.gitlabHost=null]       If using Gitlab, the host/port of the deployed instance
    * @param  {String}  [options.gitlabProtocol=https]  If using Gitlab, the protocol to use
    * @param  {String}  [options.username=sd-buildbot]           Gitlab username for checkout
    * @param  {String}  [options.email=dev-null@screwdriver.cd]  Gitlab user email for checkout
    * @param  {Boolean} [options.https=false]           Is the Screwdriver API running over HTTPS
    * @param  {String}  options.oauthClientId           OAuth Client ID provided by Gitlab application
    * @param  {String}  options.oauthClientSecret       OAuth Client Secret provided by Gitlab application
    * @param  {Object}  [options.fusebox={}]            Circuit Breaker configuration
    * @return {GitlabScm}
    */
    constructor(config = {}) {
        super();

        // Validate configuration
        this.config = Joi.attempt(config, Joi.object().keys({
            gitlabProtocol: Joi.string().optional().default('https'),
            gitlabHost: Joi.string().optional().description('Gitlab host'),
            username: Joi.string().optional().default('sd-buildbot'),
            email: Joi.string().optional().default('dev-null@screwdriver.cd'),
            https: Joi.boolean().optional().default(false),
            oauthClientId: Joi.string().required(),
            oauthClientSecret: Joi.string().required(),
            fusebox: Joi.object().default({})
        }).unknown(true), 'Invalid config for Gitlab');

        const gitlabConfig = {};

        if (this.config.gitlabHost) {
            gitlabConfig.host = this.config.gitlabHost;
            gitlabConfig.protocol = this.config.gitlabProtocol;
            gitlabConfig.pathPrefix = '';
        }

        this.breaker = new Breaker(Request, this.config.fusebox);
    }

    /**
    * Look up a repo by SCM URI
    * @method lookupScmUri
    * @param  {Object}     config Config object
    * @param  {Object}     config.scmUri The SCM URI to look up relevant info
    * @param  {Object}     config.token  Service token to authenticate with Gitlab
    * @return {Promise}                  Resolves to an object containing
    *                                    repository-related information
    */
    lookupScmUri(config) {
        const [scmHost, scmId, scmBranch] = config.scmUri.split(':');

        return this.Breaker.runCommand({
            json: true,
            method: 'GET',
            auth: {
                bearer: config.token
            },
            url: `${this.config.gitlabProtocol}://${this.config.gitlabHost}/api/v3/projects/${scmId}`
        }).then((response) => {
            checkResponseError(response)

            const [repoOwner, repoName] = response.body.path_with_namespace.split('/');

            return {
                branch: scmBranch,
                host: scmHost,
                repo: repoName,
                owner: repoOwner
            };
        });
    }

    /** Extended from screwdriver-scm-base **/

    // /**
    //  * Adds the Screwdriver webhook to the Gitlab repository
    //  * @method _addWebhook
    //  * @param  {Object}    config            Config object
    //  * @param  {String}    config.scmUri     The SCM URI to add the webhook to
    //  * @param  {String}    config.token      Service token to authenticate with Gitlab
    //  * @param  {String}    config.webhookUrl The URL to use for the webhook notifications
    //  * @return {Promise}                     Resolve means operation completed without failure.
    //  */
    // _addWebhook(config) {
    // }

    /**
    * Parses a SCM URL into a screwdriver-representable ID
    * @method _parseUrl
    * @param  {Object}     config              Config object
    * @param  {String}     config.checkoutUrl  The checkoutUrl to parse
    * @param  {String}     config.token        The token used to authenticate to the SCM service
    * @return {Promise}                        Resolves to an ID of 'serviceName:repoId:branchName'
    */
    _parseUrl(config) {
        const repoInfo = getRepoInfo(config.checkoutUrl);

        // fetch repoId
        var requestOptions = {
            json: true,
            method: 'GET',
            auth: {
                bearer: config.token
            },
            url: `${this.config.gitlabProtocol}://${this.config.gitlabHost}/api/v3/projects/${repoInfo.username}%2F${repoInfo.repo}`
        };

        return this.breaker.runCommand(requestOptions)
            .then((response) => {
                checkResponseError(response)
                return `${repoInfo.hostname}:${response.body.id}:${repoInfo.branch}`;
            });
    }

    // /**
    //  * Given a SCM webhook payload & its associated headers, aggregate the
    //  * necessary data to execute a Screwdriver job with.
    //  * @method _parseHook
    //  * @param  {Object}  payloadHeaders  The request headers associated with the
    //  *                                   webhook payload
    //  * @param  {Object}  webhookPayload  The webhook payload received from the
    //  *                                   SCM service.
    //  * @return {Promise}                 A key-map of data related to the received
    //  *                                   payload
    //  */
    // _parseHook(payloadHeaders, webhookPayload) {
    // }

    /**
    * Checkout the source code from a repository; resolves as an object with checkout commands
    * @method getCheckoutCommand
    * @param  {Object}    config
    * @param  {String}    config.branch        Pipeline branch
    * @param  {String}    config.host          Scm host to checkout source code from
    * @param  {String}    config.org           Scm org name
    * @param  {String}    config.repo          Scm repo name
    * @param  {String}    config.sha           Commit sha
    * @param  {String}    [config.prRef]       PR reference (can be a PR branch or reference)
    * @return {Promise}
    */
    _getCheckoutCommand(config) {
        const checkoutUrl = `${config.host}/${config.org}/${config.repo}`;
        const checkoutRef = config.prRef ? config.branch : config.sha; // if PR, use pipeline branch
        const command = [];

        // Git clone
        command.push(`echo Cloning ${checkoutUrl}, on branch ${config.branch}`);
        command.push(`export SCM_URL=${checkoutUrl}`);
        command.push('if [ ! -z $SCM_USERNAME ] && [ ! -z $SCM_ACCESS_TOKEN ]; then '
        + 'SCM_URL="$SCM_USERNAME:$SCM_ACCESS_TOKEN@$SCM_URL"; fi');
        command.push(`git clone --quiet --progress --branch ${config.branch} `
            + 'https://$SCM_URL $SD_SOURCE_DIR');
            // Reset to SHA
            command.push(`git reset --hard ${checkoutRef}`);
            command.push(`echo Reset to ${checkoutRef}`);
            // Set config
            command.push('echo Setting user name and user email');
            command.push(`git config user.name ${this.config.username}`);
            command.push(`git config user.email ${this.config.email}`);

            // For pull requests
            if (config.prRef) {
                const prRef = config.prRef.replace('merge', 'head:pr');

                // Fetch a pull request
                command.push(`echo Fetching PR and merging with ${config.branch}`);
                command.push(`git fetch origin ${prRef}`);
                // Merge a pull request with pipeline branch
                command.push(`git merge --no-edit ${config.sha}`);
            }

            return Promise.resolve({
                name: 'sd-checkout-code',
                command: command.join(' && ')
            });
        }

        /**
        * Decorate a given SCM URI with additional data to better display
        * related information. If a branch suffix is not provided, it will default
        * to the master branch
        * @method _decorateUrl
        * @param  {Config}    config        Configuration object
        * @param  {String}    config.scmUri The SCM URI the commit belongs to
        * @param  {String}    config.token  Service token to authenticate with Github
        * @return {Promise}
        */
        _decorateUrl(config) {
            return this.lookupScmUri({
                scmUri: config.scmUri,
                token: config.token
            }).then((scmInfo) => {
                const baseUrl = `${scmInfo.host}/${scmInfo.owner}/${scmInfo.repo}`;

                return {
                    branch: scmInfo.branch,
                    name: `${scmInfo.owner}/${scmInfo.repo}`,
                    url: `https://${baseUrl}/tree/${scmInfo.branch}`
                };
            });
        }

        /**
        * Decorate the commit based on the repository
        * @method _decorateCommit
        * @param  {Object}        config        Configuration object
        * @param  {Object}        config.scmUri SCM URI the commit belongs to
        * @param  {Object}        config.sha    SHA to decorate data with
        * @param  {Object}        config.token  Service token to authenticate with Github
        * @return {Promise}
        */
        _decorateCommit(config) {
            const commitLookup = this.lookupScmUri({
                scmUri: config.scmUri,
                token: config.token
            }).then(scmInfo =>
                this.breaker.runCommand({
                    action: 'getCommit',
                    token: config.token,
                    params: {
                        owner: scmInfo.owner,
                        repo: scmInfo.repo,
                        sha: config.sha
                    }
                })
            );
            const authorLookup = commitLookup.then((commitData) => {
                if (!commitData.author) {
                    return DEFAULT_AUTHOR;
                }

                return this.decorateAuthor({
                    token: config.token,
                    username: commitData.author.login
                });
            });

            return Promise.all([
                commitLookup,
                authorLookup
            ]).then(([commitData, authorData]) =>
            ({
                author: authorData,
                message: commitData.commit.message,
                url: commitData.html_url
            })
        );
    }

    /**
    * Decorate the author based on the Gitlab service
    * @method _decorateAuthor
    * @param  {Object}        config          Configuration object
    * @param  {Object}        config.token    Service token to authenticate with Gitlab
    * @param  {Object}        config.username Username to query more information for
    * @return {Promise}
    */
    _decorateAuthor(config) {
        // fetch repoId
        var requestOptions = {
            json: true,
            method: 'GET',
            auth: {
                bearer: config.token
            },
            url: `${this.config.gitlabProtocol}://${this.config.gitlabHost}/api/v3/users/username=${config.username}`
        };

        return this.breaker.runCommand(requestOptions)
            .then((response) => {
                checkResponseError(response)
                return {
                    avatar: response.body.avatar_url,
                    name: response.body.name,
                    username: response.body.username,
                    url: response.body.web_url
                };
            });
    }

    /**
    * Get a owners permissions on a repository
    * @method _getPermissions
    * @param  {Object}   config            Configuration
    * @param  {String}   config.scmUri     The scmUri to get permissions on
    * @param  {String}   config.token      The token used to authenticate to the SCM
    * @return {Promise}
    */
    _getPermissions(config) {
        const [scmHost, scmId, scmBranch] = config.scmUri.split(':');

        // fetch repo info from scm
        var requestOptions = {
            json: true,
            method: 'GET',
            auth: {
                bearer: config.token
            },
            url: `${this.config.gitlabProtocol}://${this.config.gitlabHost}/api/v3/projects/${scmId}`
        }

        return this.breaker.runCommand(requestOptions)
            .then((response) => {
                checkResponseError(response)

                // TODO: trasnlate gitlab::access into admin, push, pull
                // ref: https://docs.gitlab.com/ee/api/members.html
                // "admin": false,
                // "push": false,
                // "pull": true

                return {
                    admin: true,
                    push: true,
                    pull: true
                };
            });
    }

    /**
    * Get a commit sha for a specific repo#branch
    * @method getCommitSha
    * @param  {Object}   config            Configuration
    * @param  {String}   config.scmUri     The scmUri to get commit sha of
    * @param  {String}   config.token      The token used to authenticate to the SCM
    * @return {Promise}
    */
    _getCommitSha(config) {
        const [scmHost, scmId, scmBranch] = config.scmUri.split(':');

        // fetch repo#branch info from scm
        var requestOptions = {
            json: true,
            method: 'GET',
            auth: {
                bearer: config.token
            },
            url: `${this.config.gitlabProtocol}://${this.config.gitlabHost}/api/v3/projects/${scmId}/repository/branches/${scmBranch}`
        }

        return this.breaker.runCommand(requestOptions)
            .then((response) => {
                checkResponseError(response)

                return response.body.commit.id;
            });
    }

    /**
    * Update the commit status for a given repo and sha
    * @method updateCommitStatus
    * @param  {Object}   config              Configuration
    * @param  {String}   config.scmUri       The scmUri to get permissions on
    * @param  {String}   config.sha          The sha to apply the status to
    * @param  {String}   config.buildStatus  The build status used for figuring out the commit status to set
    * @param  {String}   config.token        The token used to authenticate to the SCM
    * @param  {String}   [config.jobName]    Optional name of the job that finished
    * @param  {String}   config.url          Target url
    * @return {Promise}
    */
    _updateCommitStatus(config) {
        const [scmHost, scmId, scmBranch] = config.scmUri.split(':');
        const context = config.jobName ? `Screwdriver/${config.jobName}` : 'Screwdriver';

        var requestOptions = {
            json: true,
            method: 'POST',
            auth: {
                bearer: config.token
            },
            url: `${this.config.gitlabProtocol}://${this.config.gitlabHost}/api/v3/projects/${scmId}/statuses/${config.sha}`,
            qs: {
                context,
                description: DESCRIPTION_MAP[config.buildStatus],
                state: STATE_MAP[config.buildStatus] || 'failure',
                target_url: config.url
            }
        }

        return this.breaker(requestOptions);
    }


    /**
    * Fetch content of a file from gitlab
    * @method getFile
    * @param  {Object}   config              Configuration
    * @param  {String}   config.scmUri       The scmUri to get permissions on
    * @param  {String}   config.path         The file in the repo to fetch
    * @param  {String}   config.token        The token used to authenticate to the SCM
    * @param  {String}   config.ref          The reference to the SCM, either branch or sha
    * @return {Promise}
    */
    _getFile(config) {
        const [scmHost, scmId, scmBranch] = config.scmUri.split(':');

        var requestOptions = {
            json: true,
            method: 'GET',
            auth: {
                bearer: config.token
            },
            url: `${this.config.gitlabProtocol}://${this.config.gitlabHost}/api/v3/projects/${scmId}/repository/files`,
            qs: {
                file_path: config.path,
                ref: config.ref || scmInfo.branch
            }
        }

        this.breaker(requestOptions)
            .then((response) => {
                checkResponseError(response);

                return new Buffer(response.body.content, response.body.encoding).toString();
            });
    }


    /**
     * Return a valid Bell configuration (for OAuth)
     * @method _getBellConfiguration
     * @return {Promise}
     */
    _getBellConfiguration() {
        const bellConfig = {
            provider: 'gitlab',
            clientId: this.config.oauthClientId,
            clientSecret: this.config.oauthClientSecret,
            isSecure: this.config.https,
            forceHttps: this.config.https
        };

        if (this.config.gitlabHost) {
            bellConfig.config = {
                uri: `${this.config.gitlabProtocol}://${this.config.gitlabHost}`
            };
        }

        return Promise.resolve(bellConfig);
    }

    /**
    * Retrieve stats for the executor
    * @method stats
    * @param  {Response} Object          Object containing stats for the executor
    */
    stats() {
        return this.breaker.stats();
    }

}

module.exports = GitlabScm;