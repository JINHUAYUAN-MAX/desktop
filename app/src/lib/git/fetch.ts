import { git, IGitExecutionOptions, gitNetworkArguments } from './core'
import { Repository } from '../../models/repository'
import { IGitAccount } from '../../models/git-account'
import { IFetchProgress } from '../../models/progress'
import { FetchProgressParser, executionOptionsWithProgress } from '../progress'
import { enableRecurseSubmodulesFlag } from '../feature-flag'
import { IRemote } from '../../models/remote'
import { envForRemoteOperation } from './environment'
import { Branch } from '../../models/branch'

async function getFetchArgs(
  repository: Repository,
  remote: string,
  account: IGitAccount | null,
  progressCallback?: (progress: IFetchProgress) => void
) {
  const networkArguments = await gitNetworkArguments(repository, account)

  if (enableRecurseSubmodulesFlag()) {
    return progressCallback != null
      ? [
          ...networkArguments,
          'fetch',
          '--progress',
          '--prune',
          '--recurse-submodules=on-demand',
          remote,
        ]
      : [
          ...networkArguments,
          'fetch',
          '--prune',
          '--recurse-submodules=on-demand',
          remote,
        ]
  } else {
    return progressCallback != null
      ? [...networkArguments, 'fetch', '--progress', '--prune', remote]
      : [...networkArguments, 'fetch', '--prune', remote]
  }
}

/**
 * Fetch from the given remote.
 *
 * @param repository - The repository to fetch into
 *
 * @param account    - The account to use when authenticating with the remote
 *
 * @param remote     - The remote to fetch from
 *
 * @param progressCallback - An optional function which will be invoked
 *                           with information about the current progress
 *                           of the fetch operation. When provided this enables
 *                           the '--progress' command line flag for
 *                           'git fetch'.
 */
export async function fetch(
  repository: Repository,
  account: IGitAccount | null,
  remote: IRemote,
  progressCallback?: (progress: IFetchProgress) => void
): Promise<void> {
  let opts: IGitExecutionOptions = {
    successExitCodes: new Set([0]),
    env: await envForRemoteOperation(account, remote.url),
  }

  if (progressCallback) {
    const title = `Fetching ${remote.name}`
    const kind = 'fetch'

    opts = await executionOptionsWithProgress(
      { ...opts, trackLFSProgress: true },
      new FetchProgressParser(),
      progress => {
        // In addition to progress output from the remote end and from
        // git itself, the stderr output from pull contains information
        // about ref updates. We don't need to bring those into the progress
        // stream so we'll just punt on anything we don't know about for now.
        if (progress.kind === 'context') {
          if (!progress.text.startsWith('remote: Counting objects')) {
            return
          }
        }

        const description =
          progress.kind === 'progress' ? progress.details.text : progress.text
        const value = progress.percent

        progressCallback({
          kind,
          title,
          description,
          value,
          remote: remote.name,
        })
      }
    )

    // Initial progress
    progressCallback({ kind, title, value: 0, remote: remote.name })
  }

  const args = await getFetchArgs(
    repository,
    remote.name,
    account,
    progressCallback
  )
  await git(args, repository.path, 'fetch', opts)
}

/** Fetch a given refspec from the given remote. */
export async function fetchRefspec(
  repository: Repository,
  account: IGitAccount | null,
  remote: IRemote,
  refspec: string
): Promise<void> {
  const options = {
    successExitCodes: new Set([0, 128]),
    env: await envForRemoteOperation(account, remote.url),
  }

  const networkArguments = await gitNetworkArguments(repository, account)

  const args = [...networkArguments, 'fetch', remote.name, refspec]

  await git(args, repository.path, 'fetchRefspec', options)
}

export async function fastForwardBranches(
  repository: Repository,
  branches: ReadonlyArray<Branch>
): Promise<ReadonlyArray<Branch>> {
  const opts: IGitExecutionOptions = {
    successExitCodes: new Set([0, 1]),
    env: {
      GIT_REFLOG_ACTION: 'pull',
    },
  }

  const branchPairs = branches.map(
    branch => `refs/remotes/${branch.upstream}:refs/heads/${branch.name}`
  )

  const result = await git(
    [
      '-c',
      'fetch.output=full',
      '-c',
      'core.abbrev=40',
      'fetch',
      '.',
      '--show-forced-updates',
      '-v',
      ...branchPairs,
    ],
    repository.path,
    'fastForwardBranches',
    opts
  )

  const lines = result.combinedOutput.split('\n')

  // Remove the first 'From .'  line
  lines.splice(0, 1)

  // Remove the trailing newline
  lines.splice(-1, 1)

  const updatedBranches = new Map<String, String>()

  for (const line of lines) {
    const pieces = line.split(' ').filter(piece => piece.length > 0)

    if (pieces.length === 0) {
      continue
    }

    if (pieces[0].indexOf('..') < 0) {
      // Omit non-updated branches
      continue
    }

    const to = pieces[0].split('..')[1]
    updatedBranches.set(pieces[pieces.length - 1], to)
  }

  return branches.filter(branch => updatedBranches.has(branch.name))
}
