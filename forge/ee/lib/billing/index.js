module.exports.init = async function (app) {
    // Set the billing feature flag
    app.config.features.register('billing', true, true)

    const stripe = require('stripe')(app.config.billing.stripe.key)

    /**
     * Get the Stripe product/price ids for the given team.
     *
     * These are provided via flowforge.yml.
     *  - billing.stripe.team_* provide the default values.
     *  - billing.stripe.teams.<type-name>.* provide type-specific values
     *
     * Example flowforge.yml config:
     *   billing:
     *     stripe:
     *       ...
     *       team_price: <default team price>
     *       team_product: <default team product>
     *       device_price: <default device price>
     *       device_product: <default device product>
     *       ...
     *       teams:
     *         starter:
     *           price: <starter team price>
     *           product: <starter team product>
     *
     * @param {Team} team The team object to get the billing ids for
     * @returns Object containing `price` and `product` properties
     */
    function getBillingIdsForTeam (team) {
        const result = {
            price: app.config.billing.stripe.team_price,
            product: app.config.billing.stripe.team_product,
            device: {
                price: app.config.billing.stripe.device_price,
                product: app.config.billing.stripe.device_product
            }
        }
        if (app.config.billing.stripe.teams?.[team.TeamType.name]) {
            result.price = app.config.billing.stripe.teams[team.TeamType.name].price || result.price
            result.product = app.config.billing.stripe.teams[team.TeamType.name].product || result.product
        }
        return result
    }

    return {
        createSubscriptionSession: async (team, coupon) => {
            const billingIds = getBillingIdsForTeam(team)

            const sub = {
                mode: 'subscription',
                line_items: [{
                    price: billingIds.price,
                    quantity: 1
                }],
                subscription_data: {
                    metadata: {
                        team: team.hashid
                    }
                },
                tax_id_collection: {
                    enabled: true
                },
                client_reference_id: team.hashid,
                payment_method_types: ['card'],
                success_url: `${app.config.base_url}/team/${team.slug}/overview?billing_session={CHECKOUT_SESSION_ID}`,
                cancel_url: `${app.config.base_url}/team/${team.slug}/overview`
            }

            if (app.config.billing?.stripe?.activation_price) {
                sub.line_items.push({
                    price: app.config.billing.stripe.activation_price,
                    quantity: 1
                })
            }

            if (coupon) {
                sub.discounts = [
                    {
                        promotion_code: coupon
                    }
                ]
            } else {
                sub.allow_promotion_codes = true
            }

            const session = await stripe.checkout.sessions.create(sub)
            app.log.info(`Creating Subscription for team ${team.hashid}`)
            return session
        },
        addProject: async (team, project) => {
            let projectProduct = app.config.billing.stripe.project_product
            let projectPrice = app.config.billing.stripe.project_price
            const projectType = await project.getProjectType()
            if (projectType) {
                if (projectType.properties.billingProductId) {
                    projectProduct = projectType.properties.billingProductId
                }
                if (projectType.properties.billingPriceId) {
                    projectPrice = projectType.properties.billingPriceId
                }
            }

            const subscription = await app.db.models.Subscription.byTeam(team.id)

            const existingSub = await stripe.subscriptions.retrieve(subscription.subscription)
            const subItems = existingSub.items

            let projectItem = false
            subItems.data.forEach(item => {
                if (item.plan.product === projectProduct) {
                    projectItem = item
                }
            })

            app.log.info(`Adding Project ${project.id} to Subscription for team ${team.hashid}`)

            if (projectItem) {
                const metadata = existingSub.metadata ? existingSub.metadata : {}
                // console.log('updating metadata', metadata)
                metadata[project.id] = 'true'
                // console.log(metadata)
                const update = {
                    quantity: projectItem.quantity + 1,
                    proration_behavior: 'always_invoice'
                }
                // TODO update meta data?
                try {
                    await stripe.subscriptionItems.update(projectItem.id, update)
                    await stripe.subscriptions.update(subscription.subscription, {
                        metadata
                    })
                } catch (error) {
                    app.log.warn(`Problem adding project to subscription\n${error.message}`)
                }
            } else {
                const metadata = {}
                metadata[project.id] = 'true'
                // metadata[team] = team.hashid
                const update = {
                    items: [{
                        price: projectPrice,
                        quantity: 1
                    }],
                    metadata
                }
                try {
                    await stripe.subscriptions.update(subscription.subscription, update)
                } catch (error) {
                    app.log.warn(`Problem adding first project to subscription\n${error.message}`)
                    throw error
                }
            }
        },
        removeProject: async (team, project) => {
            let projectProduct = app.config.billing.stripe.project_product
            const projectType = await project.getProjectType()
            if (projectType) {
                if (projectType.properties.billingProductId) {
                    projectProduct = projectType.properties.billingProductId
                }
            }

            const subscription = await app.db.models.Subscription.byTeam(team.id)

            const existingSub = await stripe.subscriptions.retrieve(subscription.subscription)
            const subItems = existingSub.items

            let projectItem = false
            subItems.data.forEach(item => {
                if (item.plan.product === projectProduct) {
                    projectItem = item
                }
            })

            app.log.info(`Removing Project ${project.id} to Subscription for team ${team.hashid}`)

            if (projectItem) {
                const metadata = existingSub.metadata ? existingSub.metadata : {}
                metadata[project.id] = ''
                const newQuantity = projectItem.quantity > 0 ? projectItem.quantity - 1 : 0
                const update = {
                    quantity: newQuantity
                }
                if (projectItem.quantity === 1) {
                    update.proration_behavior = 'always_invoice'
                }

                try {
                    await stripe.subscriptionItems.update(projectItem.id, update)
                    await stripe.subscriptions.update(subscription.subscription, {
                        metadata
                    })
                } catch (err) {
                    app.log.warn(`failed removing project from subscription\n${err.message}`)
                    throw err
                }
            } else {
                // not found?
                app.log.warn('Project not found in Subscription, possible Grandfathered in')
            }
        },
        updateTeamMemberCount: async (team) => {
            const billingIds = getBillingIdsForTeam(team)

            const subscription = await app.db.models.Subscription.byTeam(team.id)
            if (subscription) {
                const existingSub = await stripe.subscriptions.retrieve(subscription.subscription)
                const subItems = existingSub.items

                const teamItem = subItems.data.find(item => item.plan.product === billingIds.product)

                const memberCount = await team.memberCount()

                if (teamItem.quantity !== memberCount) {
                    app.log.info(`Updating team ${team.hashid} subscription member count to ${memberCount}`)
                    const update = {
                        quantity: memberCount,
                        proration_behavior: 'always_invoice'
                    }
                    try {
                        await stripe.subscriptionItems.update(teamItem.id, update)
                    } catch (error) {
                        app.log.warn(`Problem updating team ${team.hashid} subscription: ${error.message}`)
                    }
                } else {
                    app.log.info(`Team ${team.hashid} subscription member count up to date`)
                }
            }
        },
        updateTeamDeviceCount: async (team) => {
            const billingIds = getBillingIdsForTeam(team)
            if (!billingIds.device.product) {
                return
            }
            const subscription = await app.db.models.Subscription.byTeam(team.id)
            if (subscription) {
                const deviceCount = await team.deviceCount()
                const deviceFreeAllocation = team.TeamType.getProperty('deviceFreeAllocation') || 0
                const billableCount = Math.max(0, deviceCount - deviceFreeAllocation)
                const existingSub = await stripe.subscriptions.retrieve(subscription.subscription)
                const subItems = existingSub.items
                const deviceItem = subItems.data.find(item => item.plan.product === billingIds.device.product)
                if (deviceItem) {
                    if (deviceItem.quantity !== billableCount) {
                        app.log.info(`Updating team ${team.hashid} subscription device count to ${billableCount}`)
                        const update = {
                            quantity: billableCount,
                            proration_behavior: 'always_invoice'
                        }
                        try {
                            await stripe.subscriptionItems.update(deviceItem.id, update)
                        } catch (error) {
                            app.log.warn(`Problem updating team ${team.hashid} subscription: ${error.message}`)
                        }
                    }
                } else if (billableCount > 0) {
                    // Need to add the device item to the subscription
                    const update = {
                        items: [{
                            price: billingIds.device.price,
                            quantity: billableCount
                        }]
                    }
                    try {
                        app.log.info(update)
                        await stripe.subscriptions.update(subscription.subscription, update)
                    } catch (error) {
                        console.log(error)
                        app.log.warn(`Problem adding first device to subscription\n${error.message}`)
                        throw error
                    }
                }
            }
        },
        closeSubscription: async (subscription) => {
            app.log.info(`Closing subscription for team ${subscription.Team.hashid}`)

            await stripe.subscriptions.del(subscription.subscription, {
                invoice_now: true,
                prorate: true
            })
            await subscription.destroy()
        }
    }
}
