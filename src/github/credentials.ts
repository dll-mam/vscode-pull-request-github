/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Octokit } from '@octokit/rest';
import { ApolloClient, InMemoryCache, NormalizedCacheObject } from 'apollo-boost';
import { setContext } from 'apollo-link-context';
import { createHttpLink } from 'apollo-link-http';
import fetch from 'node-fetch';
import * as vscode from 'vscode';
import Logger from '../common/logger';
import * as PersistentState from '../common/persistentState';
import { ITelemetry } from '../common/telemetry';
import { agent } from '../env/node/net';
import { OctokitCommon } from './common';
import { getEnterpriseUri, hasEnterpriseUri } from './utils';

const TRY_AGAIN = 'Try again?';
const CANCEL = 'Cancel';
const SIGNIN_COMMAND = 'Sign in';
const IGNORE_COMMAND = "Don't show again";

const PROMPT_FOR_SIGN_IN_SCOPE = 'prompt for sign in';
const PROMPT_FOR_SIGN_IN_STORAGE_KEY = 'login';

// If the scopes are changed, make sure to notify all interested parties to make sure this won't cause problems.
const SCOPES = ['read:user', 'user:email', 'repo'];

export enum AuthProvider {
	github = 'github',
	'github-enterprise' = 'github-enterprise'
}

export interface GitHub {
	octokit: Octokit;
	graphql: ApolloClient<NormalizedCacheObject> | null;
	currentUser?: OctokitCommon.PullsGetResponseUser;
}

export class CredentialStore implements vscode.Disposable {
	private _githubAPI: GitHub | undefined;
	private _sessionId: string | undefined;
	private _githubEnterpriseAPI: GitHub | undefined;
	private _enterpriseSessionId: string | undefined;
	private _disposables: vscode.Disposable[];
	private _onDidInitialize: vscode.EventEmitter<void> = new vscode.EventEmitter();
	public readonly onDidInitialize: vscode.Event<void> = this._onDidInitialize.event;

	constructor(private readonly _telemetry: ITelemetry) {
		this._disposables = [];
		this._disposables.push(
			vscode.authentication.onDidChangeSessions(() => {
				if (!this.isAuthenticated(AuthProvider.github)) {
					this.initialize(AuthProvider.github);
				}

				if (!this.isAuthenticated(AuthProvider['github-enterprise']) && hasEnterpriseUri()) {
					this.initialize(AuthProvider['github-enterprise']);
				}
			}),
		);
	}

	public async initialize(authProviderId: AuthProvider, force: boolean = false): Promise<void> {
		if (authProviderId === AuthProvider['github-enterprise']) {
			if (!hasEnterpriseUri()) {
				Logger.debug(`GitHub Enterprise provider selected without URI.`, 'Authentication');
				return;
			}
		}
		let session;
		try {
			session = await vscode.authentication.getSession(authProviderId, SCOPES, { createIfNone: false, forceNewSession: force });
		} catch (e) {
			if (force && (e.message === 'User did not consent to login.')) {
				// There are cases where a forced login may not be 100% needed, so just continue as usual if
				// the user didn't consent to the login prompt.
			} else {
				throw e;
			}
		}

		if (session) {
			if (authProviderId === AuthProvider.github) {
				this._sessionId = session.id;
			} else {
				this._enterpriseSessionId = session.id;
			}
			const github = await this.createHub(session.accessToken, authProviderId);
			if (authProviderId === AuthProvider.github) {
				this._githubAPI = github;
			} else {
				this._githubEnterpriseAPI = github;
			}
			await this.setCurrentUser(github);
			this._onDidInitialize.fire();
		} else {
			Logger.debug(`No GitHub${getGitHubSuffix(authProviderId)} token found.`, 'Authentication');
		}
	}

	private async doCreate(force?: boolean) {
		await this.initialize(AuthProvider.github, force);
		if (hasEnterpriseUri()) {
			await this.initialize(AuthProvider['github-enterprise'], force);
		}
	}

	public async create() {
		this.doCreate();
	}

	public async recreate() {
		return this.doCreate(true);
	}

	public async reset() {
		this._githubAPI = undefined;
		this._githubEnterpriseAPI = undefined;
		return this.create();
	}

	public isAnyAuthenticated() {
		return this.isAuthenticated(AuthProvider.github) || this.isAuthenticated(AuthProvider['github-enterprise']);
	}

	public isAuthenticated(authProviderId: AuthProvider): boolean {
		if (authProviderId === AuthProvider.github) {
			return !!this._githubAPI;
		}
		return !!this._githubEnterpriseAPI;
	}

	public getHub(authProviderId: AuthProvider): GitHub | undefined {
		if (authProviderId === AuthProvider.github) {
			return this._githubAPI;
		}
		return this._githubEnterpriseAPI;
	}

	public async getHubOrLogin(authProviderId: AuthProvider): Promise<GitHub | undefined> {
		if (authProviderId === AuthProvider.github) {
			return this._githubAPI ?? (await this.login(authProviderId));
		}
		return this._githubEnterpriseAPI ?? (await this.login(authProviderId));
	}

	public async showSignInNotification(authProviderId: AuthProvider): Promise<GitHub | undefined> {
		if (PersistentState.fetch(PROMPT_FOR_SIGN_IN_SCOPE, PROMPT_FOR_SIGN_IN_STORAGE_KEY) === false) {
			return;
		}

		const result = await vscode.window.showInformationMessage(
			`In order to use the Pull Requests functionality, you must sign in to GitHub${getGitHubSuffix(authProviderId)}`,
			SIGNIN_COMMAND,
			IGNORE_COMMAND,
		);

		if (result === SIGNIN_COMMAND) {
			return await this.login(authProviderId);
		} else {
			// user cancelled sign in, remember that and don't ask again
			PersistentState.store(PROMPT_FOR_SIGN_IN_SCOPE, PROMPT_FOR_SIGN_IN_STORAGE_KEY, false);

			/* __GDPR__
				"auth.cancel" : {}
			*/
			this._telemetry.sendTelemetryEvent('auth.cancel');
		}
	}

	public async login(authProviderId: AuthProvider): Promise<GitHub | undefined> {
		/* __GDPR__
			"auth.start" : {}
		*/
		this._telemetry.sendTelemetryEvent('auth.start');

		const errorPrefix = `Error signing in to GitHub${getGitHubSuffix(authProviderId)}`;
		let retry: boolean = true;
		let octokit: GitHub | undefined = undefined;


		while (retry) {
			try {
				const token = await this.getSessionOrLogin(authProviderId);
				octokit = await this.createHub(token, authProviderId);
			} catch (e) {
				Logger.appendLine(`${errorPrefix}: ${e}`);
				if (e instanceof Error && e.stack) {
					Logger.appendLine(e.stack);
				}
			}

			if (octokit) {
				retry = false;
			} else {
				retry = (await vscode.window.showErrorMessage(errorPrefix, TRY_AGAIN, CANCEL)) === TRY_AGAIN;
			}
		}

		if (octokit) {
			this._githubAPI = octokit;
			await this.setCurrentUser(octokit);

			/* __GDPR__
				"auth.success" : {}
			*/
			this._telemetry.sendTelemetryEvent('auth.success');
		} else {
			/* __GDPR__
				"auth.fail" : {}
			*/
			this._telemetry.sendTelemetryEvent('auth.fail');
		}

		return octokit;
	}

	public isCurrentUser(username: string): boolean {
		return this._githubAPI?.currentUser?.login === username || this._githubEnterpriseAPI?.currentUser?.login == username;
	}

	public getCurrentUser(authProviderId: AuthProvider): OctokitCommon.PullsGetResponseUser {
		const github = this.getHub(authProviderId);
		const octokit = github?.octokit;
		return (octokit && github?.currentUser)!;
	}

	public async hasSession(authProviderId: AuthProvider): Promise<boolean> {
		try {
			return await vscode.authentication.hasSession(authProviderId, SCOPES);
		} catch (e) {
			// When the provider id is github-enterprise hasSession throws.
			return false;
		}
	}

	private async setCurrentUser(github: GitHub): Promise<void> {
		const user = await github.octokit.users.getAuthenticated({});
		github.currentUser = user.data;
	}

	private async getSessionOrLogin(authProviderId: AuthProvider): Promise<string> {
		const session = await vscode.authentication.getSession(authProviderId, SCOPES, { createIfNone: true });
		if (authProviderId === AuthProvider.github) {
			this._sessionId = session.id;
		} else {
			this._enterpriseSessionId = session.id;
		}
		return session.accessToken;
	}

	private async createHub(token: string, authProviderId: AuthProvider): Promise<GitHub> {
		let baseUrl = 'https://api.github.com';
		let enterpriseServerUri: vscode.Uri | undefined;
		if (authProviderId === AuthProvider['github-enterprise']) {
			enterpriseServerUri = getEnterpriseUri();
		}

		if (enterpriseServerUri) {
			baseUrl = `${enterpriseServerUri.scheme}://${enterpriseServerUri.authority}/api/v3`;
		}

		let fetchCore: ((url: string, options: { headers?: Record<string, string> }) => any) | undefined;
		if (vscode.env.uiKind === vscode.UIKind.Web) {
			fetchCore = (url: string, options: { headers?: Record<string, string> }) => {
				if (options.headers !== undefined) {
					const { 'user-agent': userAgent, ...headers } = options.headers;
					if (userAgent) {
						options.headers = headers;
					}
				}
				return fetch(url, options);
			};
		}

		const octokit = new Octokit({
			request: { agent, fetch: fetchCore },
			userAgent: 'GitHub VSCode Pull Requests',
			// `shadow-cat-preview` is required for Draft PR API access -- https://developer.github.com/v3/previews/#draft-pull-requests
			previews: ['shadow-cat-preview'],
			auth: `${token || ''}`,
			baseUrl: baseUrl,
		});

		if (enterpriseServerUri) {
			baseUrl = `${enterpriseServerUri.scheme}://${enterpriseServerUri.authority}/api`;
		}

		const graphql = new ApolloClient({
			link: link(baseUrl, token || ''),
			cache: new InMemoryCache(),
			defaultOptions: {
				query: {
					fetchPolicy: 'no-cache',
				},
			},
		});

		const github: GitHub = {
			octokit,
			graphql,
		};
		await this.setCurrentUser(github);
		return github;
	}

	dispose() {
		this._disposables.forEach(disposable => disposable.dispose());
	}
}

const link = (url: string, token: string) =>
	setContext((_, { headers }) => ({
		headers: {
			...headers,
			authorization: token ? `Bearer ${token}` : '',
			Accept: 'application/vnd.github.shadow-cat-preview+json, application/vnd.github.antiope-preview+json',
		},
	})).concat(
		createHttpLink({
			uri: `${url}/graphql`,
			// https://github.com/apollographql/apollo-link/issues/513
			fetch: fetch as any,
		}),
	);

function getGitHubSuffix(authProviderId: AuthProvider) {
	return authProviderId === AuthProvider.github ? '' : ' Enterprise';
}
